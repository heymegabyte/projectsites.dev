/**
 * @module mocks/fixtures/feature-flags
 *
 * @description
 * Mock fixtures for the **Feature Flags** admin section — LAYER 1 of the two-layer
 * flag control plane (`pages/admin/sections/feature-flags.component.ts`, route
 * `/admin/feature-flags`), the platform-ops surface for the operator. The section's
 * LIST read (`GET /feature-flags`) is ALREADY fixtured by `hosting.fixture.ts`
 * (`featureFlagsFixture`) and is intentionally NOT duplicated here. This module adds
 * the THREE reads the list fixture doesn't cover — all fired lazily when an operator
 * expands a flag card (`openDetail`) or opens its spec sheet (`openDossier`):
 *
 * | Registry key                                | Factory                       | Fired by                                                           | Worker contract                                                                              |
 * | ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
 * | `GET /super-admin/feature-flags`            | {@link superAdminFlagsFixture } | `reload()` — ONLY when `isSuperAdmin()` (the D1 override merge)     | `{ flags: { key; enabled_globally:0\|1; rollout_pct; kill_switch:0\|1; updated_at }[] }` (`routes/super_admin.ts` → `flag_overrides`) |
 * | `GET /feature-flags/:key`                   | {@link flagDetailFixture }      | `openDetail(flag)` + `openDossier(flag)` (public — no super-admin)  | `{ definition: FlagDefinition; resolved: ResolvedFlag; docs: FlagDocs \| null }` (`routes/features.ts`) |
 * | `GET /super-admin/feature-flags/:key/audit` | {@link flagAuditFixture }       | `openDetail(flag)` + `applyOverride(...)` — ONLY when super-admin   | `{ entries: AuditEntry[] }` (`routes/super_admin.ts` → `super_admin_audit`, `summarizeAuditRow`) |
 *
 * All three are typed to the EXACT WORKER WIRE shape, so wiring the real endpoint is a
 * provider SWAP, not a rewrite.
 *
 * ## Flag-gating + super-admin gating (the irony this section documents)
 *
 * The /admin/feature-flags SECTION is NOT itself feature-flagged — it's an auth-only
 * admin nav route (the flag control plane can't gate itself behind a flag). But two of
 * its three reads are **super-admin-gated at the CLIENT**, not by a worker flag:
 *
 * - `GET /super-admin/feature-flags` (the D1-override merge) + `GET /super-admin/
 *   feature-flags/:key/audit` (per-flag history) fire ONLY when
 *   `AdminStateService.isSuperAdmin()` is true, and BOTH are wrapped in fail-soft
 *   try/catch (a non-super-admin 403 → registry defaults stand / empty audit). So on
 *   `?mock=1`, whether these two fixtures are hit depends on the demo identity's
 *   `is_super_admin` (from the already-mocked `GET /auth/me`): a super-admin demo lights
 *   up the D1-override badges + the change-history timeline; a non-super-admin demo
 *   simply never fires them and the cards show registry defaults with an empty history.
 *   Serving them is harmless either way (an unmatched route just passes through), and
 *   having them fixtured means the super-admin demo path is fully populated.
 * - `GET /feature-flags/:key` (the detail: definition + resolved + the FLAG_DOCS block)
 *   is PUBLIC — no flag, no super-admin — so the "Inspect" expander + "Spec ↗" sheet
 *   render for every demo identity.
 *
 * ## What renders on `?mock=1`
 *
 * With the list fixture's registry slice already on screen, expanding any card fires
 * `GET /feature-flags/:key` → {@link flagDetailFixture} serves the rich detail
 * (checklist ✓ list + "what this does" prose + smoke-test steps + automated-coverage
 * specs + references + the resolved ON/rollout badge). A super-admin demo additionally
 * gets `GET /super-admin/feature-flags` → the two D1-override rows (so `site_wfp_hosting`
 * + `claim_flow` show the "D1 override" source chip), and `GET /super-admin/feature-flags/
 * :key/audit` → a believable change-history timeline (enable → rollout bumps → a
 * killswitch-then-restore, each with an actor + reason).
 *
 * @remarks
 * - `GET /feature-flags/:key` + `GET /super-admin/feature-flags/:key/audit` are
 *   registered under `:param` PATTERN keys, so ONE body serves EVERY flag key. The
 *   interceptor strips the path before dispatch (a factory sees only `(state, query)`,
 *   never the `:key`), so — exactly like the ai-logs / voice detail fixtures — each
 *   serves ONE canonical, internally-consistent body for any key: the detail features
 *   `site_wfp_hosting` (the richest registry flag, and the one the list fixture leads
 *   with); the audit is that flag's believable history. `detailForKey` / `auditForKey`
 *   are exported so a spec (and a future interceptor that forwards the `:key`) can
 *   resolve an explicit key.
 * - `GET /super-admin/feature-flags` is an EXACT key (3 path segments) and can never be
 *   shadowed by the `:key/audit` PATTERN (4 segments, anchored regex) — a different
 *   shape AND exact-beats-param precedence both hold.
 * - `state` variants: `populated`/`loading`/default → the rich bodies; `empty` → the
 *   honest edges (no D1 overrides yet / a flag with no change history / docs still the
 *   registry fallback). `error` is handled by the interceptor (it throws a 500 before
 *   these run).
 */
import type { AuditEntry } from '../../pages/admin/sections/feature-flags/audit-timeline.component';
import type { FixtureFactory, MockState } from './index';

// ───────────────────── GET /super-admin/feature-flags ─────────────────────

/**
 * One GLOBAL operator-override row as the worker emits it from
 * `GET /api/super-admin/feature-flags` (`routes/super_admin.ts`). The worker reads
 * the canonical `flag_overrides` table (`scope='global'`, `scope_id='*'`) and returns
 * the LEGACY numeric shape the frontend's `reload()` merge reads: `enabled_globally`
 * + `kill_switch` are `0 | 1` (SQLite booleans), `rollout_pct` is a number, plus the
 * `updated_at` the worker also selects.
 */
export interface SuperAdminFlagOverrideRow {
  readonly key: string;
  readonly enabled_globally: 0 | 1;
  readonly rollout_pct: number;
  readonly kill_switch: 0 | 1;
  readonly updated_at: string;
}

/** The `GET /api/super-admin/feature-flags` envelope — the worker returns `{ flags }`. */
export interface SuperAdminFlagsResponse {
  flags: SuperAdminFlagOverrideRow[];
}

/** The flag the detail + audit fixtures feature (the richest registry row; the one the list leads with). */
export const DETAIL_FLAG_KEY = 'site_wfp_hosting';

/**
 * A believable slice of GLOBAL overrides — only flags whose runtime state DIFFERS from
 * their code-registry default have a row here (the worker only returns rows that exist
 * in `flag_overrides`). `site_wfp_hosting` was promoted to 100% via an override;
 * `claim_flow` was enabled to a partial 25% rollout. The merge in `reload()` tags both
 * `source:'d1'` so the list cards show the "D1 override" chip.
 */
const OVERRIDE_ROWS: readonly SuperAdminFlagOverrideRow[] = [
  {
    key: DETAIL_FLAG_KEY,
    enabled_globally: 1,
    rollout_pct: 100,
    kill_switch: 0,
    updated_at: isoMinutesAgo(42),
  },
  {
    key: 'claim_flow',
    enabled_globally: 1,
    rollout_pct: 25,
    kill_switch: 0,
    updated_at: isoMinutesAgo(310),
  },
];

/**
 * Super-admin global-overrides factory. `empty` → `{ flags: [] }` (no overrides set yet
 * → every list card stays at its registry default, `source:'registry'`);
 * `populated`/`loading`/default → the two believable override rows. `error` is handled
 * by the interceptor (it throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const superAdminFlagsFixture: FixtureFactory<SuperAdminFlagsResponse> = (
  state: MockState,
): SuperAdminFlagsResponse => {
  if (state === 'empty') return { flags: [] };
  return { flags: OVERRIDE_ROWS.map((r) => ({ ...r })) };
};

// ───────────────────────── GET /feature-flags/:key ─────────────────────────

/** The registry definition the worker spreads from `FLAG_REGISTRY[key]` (`modules/feature_flags/registry.ts`). */
export interface FlagDetailDefinition {
  readonly key: string;
  readonly description: string;
  readonly default_enabled: boolean;
  readonly default_rollout_percent: number;
  readonly stage: 'experimental' | 'beta' | 'stable' | 'deprecated' | 'killswitch';
  readonly owner_email: string;
}

/** The scope-resolved state the worker returns from `resolveFlag(...)` (mirrors the component's `ResolvedFlag`). */
export interface FlagDetailResolved {
  readonly enabled: boolean;
  readonly rollout_percent: number;
  readonly stage: string;
  readonly source: 'registry' | 'global' | 'org' | 'tenant';
}

/** The `FLAG_DOCS[key]` block (`modules/feature_flags/docs.ts`), spread verbatim into the detail. */
export interface FlagDetailDocs {
  readonly checklist: string[];
  readonly explanation: string;
  readonly smoke_test: string[];
  readonly e2e_tests?: string[];
  readonly screenshots?: { url: string; caption: string; alt?: string }[];
  readonly references?: string[];
}

/** The `GET /api/feature-flags/:key` envelope — the worker returns `{ definition, resolved, docs }`. */
export interface FlagDetailResponse {
  definition: FlagDetailDefinition;
  resolved: FlagDetailResolved;
  docs: FlagDetailDocs | null;
}

/**
 * The canonical detail the live factory serves (for `site_wfp_hosting`) — the registry
 * definition + a GLOBAL-resolved ON state (matching its override row above) + the real
 * FLAG_DOCS block (checklist / explanation / smoke_test / e2e_tests / references),
 * verbatim-shaped like `modules/feature_flags/docs.ts`. Every detail block the expander
 * + spec sheet render (✓ checklist, "what this does", smoke steps, automated coverage,
 * references, resolved badge) has real matching content.
 */
const WFP_HOSTING_DETAIL: FlagDetailResponse = {
  definition: {
    key: DETAIL_FLAG_KEY,
    description:
      'WfP site hosting — every new generated site born on a Cloudflare Workers-for-Platforms dispatch namespace (a preview slot + a production slot), so the dispatched per-site Worker serves instead of the R2-static-direct path. Additive + fail-soft: any WfP miss falls back to R2.',
    default_enabled: true,
    default_rollout_percent: 100,
    stage: 'beta',
    owner_email: 'brian@megabyte.space',
  },
  resolved: {
    enabled: true,
    rollout_percent: 100,
    stage: 'beta',
    // A GLOBAL override row exists for this flag (see OVERRIDE_ROWS), so resolution wins there.
    source: 'global',
  },
  docs: {
    checklist: [
      'Every new site born on a WfP dispatch namespace (preview + production slots)',
      'Dispatched per-site Worker serves instead of the R2-static-direct path',
      'Additive + fail-soft — any WfP miss falls back to the R2 serve path',
      'Gate order: auth → this flag (404 dark, never 403) → the dispatch handler',
      'Off (default-off historically; now promoted via a global override) → pure R2 serving, zero regression',
    ],
    explanation:
      'WfP site hosting (bornW) makes every newly generated site come up on a Cloudflare Workers-for-Platforms dispatch namespace — one preview slot and one production slot — so that a dispatched per-site Worker answers the request instead of the legacy R2-static-direct serving path. The change is purely additive and fail-soft: if the dispatch namespace has no matching script, or the dispatch call errors, the request falls straight back to the existing R2 serve, so the flag can only ADD the WfP path, never break serving. It resolves on the GLOBAL scope (promoted to 100% via an operator override), which is why the detail\'s resolved source reads "global" rather than the code-registry default. Off → sites serve exactly as before, directly from R2.',
    smoke_test: [
      'Enable via a global override → generate a new site → it comes up on a WfP preview + production slot (not R2-direct)',
      'Hit the published site → the dispatched per-site Worker serves the 200 (verify the serve path header)',
      'Force a dispatch miss → the request falls back to the R2 serve with no visible change',
      'Off → the site serves directly from R2 as before (no regression)',
    ],
    e2e_tests: ['e2e/wfp-hosting.spec.ts'],
    references: ['https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/'],
  },
};

/**
 * Per-flag DETAIL factory (`GET /api/feature-flags/:key`). The interceptor strips the
 * path before dispatch (a factory sees only `(state, query)`, never the `:key`), so this
 * serves ONE canonical, fully-populated detail — `site_wfp_hosting`, the richest registry
 * flag and the one the list fixture leads with — for ANY key, so a demo expand/deep-link
 * never 404s. The precise per-key resolution lives in {@link detailForKey} (exported for
 * the spec + a future interceptor that forwards the path key).
 *
 * `empty` → the SAME definition/resolved but `docs: null` (the honest "this flag has no
 * docs entry yet → fall back to the registry description" edge the component handles).
 * `populated`/`loading`/default → the full detail with the FLAG_DOCS block.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const flagDetailFixture: FixtureFactory<FlagDetailResponse> = (
  state: MockState,
): FlagDetailResponse => {
  if (state === 'empty') return { ...WFP_HOSTING_DETAIL, docs: null };
  return cloneDetail(WFP_HOSTING_DETAIL);
};

/**
 * Build the detail for an explicit flag key — exported so the spec (and a future
 * interceptor that forwards the path `:key`) can resolve by key. Only the featured
 * `site_wfp_hosting` carries a bespoke body; any other key reuses the same canonical
 * detail with its `definition.key` / `resolved` swapped so the panel always renders.
 */
export function detailForKey(key: string | null): FlagDetailResponse {
  const base = cloneDetail(WFP_HOSTING_DETAIL);
  if (!key || key === DETAIL_FLAG_KEY) return base;
  return {
    ...base,
    definition: { ...base.definition, key },
  };
}

// ───────────────── GET /super-admin/feature-flags/:key/audit ─────────────────

/** The `GET /api/super-admin/feature-flags/:key/audit` envelope — the worker returns `{ entries }`. */
export interface FlagAuditResponse {
  entries: AuditEntry[];
}

/**
 * A believable per-flag change history for `site_wfp_hosting`, newest-first (the worker
 * orders `created_at DESC LIMIT 50`). Each entry mirrors the worker's mapped shape
 * (`id` / `actor` = actor_user_id / `action` / `summary` from `summarizeAuditRow` /
 * `reason` / `created_at`) — the arc a real promotion follows: experimental enable →
 * incremental rollout bumps → a Sev-1 killswitch-then-restore. The dangerous changes
 * (killswitch) carry a typed reason, the routine rollout bumps don't (the component's
 * confirm panel only demands a reason for dangerous changes).
 */
const WFP_HOSTING_AUDIT: readonly AuditEntry[] = [
  {
    id: 'ffa-006',
    actor: 'brian@megabyte.space',
    action: 'feature_flag_upsert',
    summary: 'rollout → 100%',
    reason: null,
    created_at: isoMinutesAgo(42),
  },
  {
    id: 'ffa-005',
    actor: 'brian@megabyte.space',
    action: 'feature_flag_upsert',
    summary: 'kill switch → off, enabled → on, rollout → 50%',
    reason: 'Upstream dispatch incident resolved — lifting the kill switch and resuming the rollout.',
    created_at: isoMinutesAgo(190),
  },
  {
    id: 'ffa-004',
    actor: 'brian@megabyte.space',
    action: 'feature_flag_upsert',
    summary: 'kill switch → on, enabled → off, rollout → 0%',
    reason: 'Sev-1: a dispatch-namespace misroute served a stale build — killing WfP hosting while we patch.',
    created_at: isoMinutesAgo(214),
  },
  {
    id: 'ffa-003',
    actor: 'ops@megabyte.space',
    action: 'feature_flag_upsert',
    summary: 'rollout → 50%',
    reason: null,
    created_at: isoMinutesAgo(1510),
  },
  {
    id: 'ffa-002',
    actor: 'ops@megabyte.space',
    action: 'feature_flag_upsert',
    summary: 'rollout → 25%',
    reason: null,
    created_at: isoMinutesAgo(2905),
  },
  {
    id: 'ffa-001',
    actor: 'brian@megabyte.space',
    action: 'feature_flag_upsert',
    summary: 'enabled → on, rollout → 5%',
    reason: null,
    created_at: isoMinutesAgo(4320),
  },
];

/**
 * Per-flag AUDIT factory (`GET /api/super-admin/feature-flags/:key/audit`). Like the
 * detail, the interceptor strips the `:key` before dispatch, so this serves ONE
 * canonical history — the believable `site_wfp_hosting` arc — for any key.
 *
 * `empty` → `{ entries: [] }` (a flag that's never been overridden → the timeline's calm
 * "No changes recorded yet." empty state); `populated`/`loading`/default → the 6-entry
 * history. `error` is handled by the interceptor (it throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const flagAuditFixture: FixtureFactory<FlagAuditResponse> = (
  state: MockState,
): FlagAuditResponse => {
  if (state === 'empty') return { entries: [] };
  return { entries: WFP_HOSTING_AUDIT.map((e) => ({ ...e })) };
};

/**
 * Build the audit history for an explicit flag key — exported so the spec (and a future
 * interceptor that forwards the path `:key`) can resolve by key. The featured
 * `site_wfp_hosting` carries the believable arc; any other key gets an empty history
 * (the honest "no changes recorded yet" state for a flag that's never been overridden).
 */
export function auditForKey(key: string | null): AuditEntry[] {
  if (!key || key === DETAIL_FLAG_KEY) return WFP_HOSTING_AUDIT.map((e) => ({ ...e }));
  return [];
}

// ───────────────────────────── helpers ─────────────────────────────

/** Deep-ish clone of a detail so a caller mutating the result never corrupts the shared source. */
function cloneDetail(d: FlagDetailResponse): FlagDetailResponse {
  return {
    definition: { ...d.definition },
    resolved: { ...d.resolved },
    docs: d.docs
      ? {
          ...d.docs,
          checklist: [...d.docs.checklist],
          smoke_test: [...d.docs.smoke_test],
          e2e_tests: d.docs.e2e_tests ? [...d.docs.e2e_tests] : undefined,
          references: d.docs.references ? [...d.docs.references] : undefined,
          screenshots: d.docs.screenshots ? d.docs.screenshots.map((s) => ({ ...s })) : undefined,
        }
      : null,
  };
}

/** ISO timestamp `minutes` in the past — keeps the override `updated_at` + audit feed reading live. */
function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}
