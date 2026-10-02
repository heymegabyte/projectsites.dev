/**
 * Feature-flag resolver. Per [[feature-flags]] supreme rule.
 *
 * Resolution order (highest priority first):
 *   1. Tenant override (`scope='tenant'`, `scope_id=site_id`)
 *   2. Org override    (`scope='org'`,    `scope_id=org_id`)
 *   3. Global override (`scope='global'`, `scope_id='*'`)
 *   4. Legacy-shape fallback (`feature_flags` — modern columns backfilled by
 *      migration 0656; see `resolveLegacyFlagShape` below)
 *   5. Registry default (`registry.ts`)
 *
 * Overrides live in D1 `flag_overrides` (per migration 0500) — this is the
 * MODERN, authoritative shape and the ONLY table the admin UI + every live
 * handler read/write. `flag_overrides` was already fully modern-shaped before
 * migration 0656 and needed no backfill.
 *
 * The LEGACY `feature_flags` table (id/org_id/flag_name/enabled/metadata_json
 * — the 0001 initial-schema shape, seeded by every 05xx/06xx_*_flag.sql
 * governance migration) has NO live runtime readers as of migration 0613's
 * own audit comment — it is a write-only admin-governance artifact. Migration
 * 0656 added 4 modern columns (`key`/`enabled_v2`/`rollout_percent`/`stage`)
 * to that table and backfilled them from each row's `flag_name`/`enabled`/
 * `metadata_json` so the table's SHAPE converges toward the universal
 * [[feature-flags]] contract — but it stays read-ONLY during the transition
 * (never written by this module) and is consulted ONLY as a step-4 fallback
 * when no `flag_overrides` row exists at any scope, so a legacy-shaped row
 * still resolves correctly without ever out-ranking the modern path.
 *
 * KV cache 60s for hot paths; admin mutations invalidate via
 * `invalidateFlagCache()`.
 */

import type { Env } from '../../types/env.js';
import { FLAG_REGISTRY, type FlagDefinition } from './registry.js';

interface FlagOverrideRow {
  scope: 'tenant' | 'org' | 'global';
  scope_id: string;
  flag_key: string;
  value_json: string;
  expires_at: string | null;
}

/** A `feature_flags` row AFTER migration 0656's backfill — `key` is the
 * flag registry key (copied from `flag_name`), `enabled_v2` mirrors the
 * legacy `enabled` INTEGER (named `_v2` to avoid a same-name type collision
 * with the pre-existing `enabled` column), `rollout_percent`/`stage` are
 * parsed out of `metadata_json` at migration time. `key IS NULL` means the
 * row predates 0656 and was never backfilled (shouldn't happen post-apply,
 * but every caller treats it as "not resolvable" rather than throwing). */
interface LegacyFlagRow {
  key: string | null;
  enabled_v2: number | null;
  rollout_percent: number;
  stage: string;
}

interface FlagState {
  enabled: boolean;
  rollout_percent: number;
  stage: string;
  source: 'registry' | 'global' | 'org' | 'tenant' | 'legacy';
}

export interface FlagScope {
  orgId?: string;
  siteId?: string;
  userId?: string;
  anonId?: string;
}

const KV_TTL = 60;

async function fetchOverride(
  env: Env,
  scope: 'tenant' | 'org' | 'global',
  scopeId: string,
  flagKey: string,
): Promise<FlagOverrideRow | null> {
  const row = await env.DB.prepare(
    `SELECT scope, scope_id, flag_key, value_json, expires_at FROM flag_overrides
     WHERE scope = ? AND scope_id = ? AND flag_key = ? AND deleted_at IS NULL
     AND (expires_at IS NULL OR expires_at > datetime('now'))
     LIMIT 1`,
  )
    .bind(scope, scopeId, flagKey)
    .first<FlagOverrideRow>()
    .catch(() => null);
  return row ?? null;
}

function parseOverride(
  row: FlagOverrideRow,
  fallback: FlagDefinition,
  source: 'global' | 'org' | 'tenant',
): FlagState {
  try {
    const value = JSON.parse(row.value_json) as Partial<{
      enabled: boolean;
      rollout_percent: number;
      stage: string;
    }>;
    return {
      enabled: value.enabled ?? fallback.default_enabled,
      rollout_percent: value.rollout_percent ?? fallback.default_rollout_percent,
      stage: value.stage ?? fallback.stage,
      source,
    };
  } catch {
    return {
      enabled: fallback.default_enabled,
      rollout_percent: fallback.default_rollout_percent,
      stage: fallback.stage,
      source,
    };
  }
}

/**
 * Transition-only fallback: resolve a flag's state from the LEGACY
 * `feature_flags` table's migration-0656-backfilled columns, for a flag key
 * that has no `flag_overrides` row at any scope. Read-ONLY — this module
 * never writes to `feature_flags`; the admin UI + every mutation path write
 * `flag_overrides` exclusively. Returns `null` when no backfilled row
 * exists (most callers — `flag_overrides` is the live write path and has
 * been since migration 0500), letting the caller fall through to the
 * registry default.
 *
 * Fails soft on any D1 error (missing table in a fresh/mocked env, etc.) —
 * same fail-soft discipline as `fetchOverride`.
 */
async function resolveLegacyFlagShape(
  env: Env,
  flagKey: string,
  fallback: FlagDefinition,
): Promise<FlagState | null> {
  const row = await env.DB.prepare(
    `SELECT key, enabled_v2, rollout_percent, stage FROM feature_flags
     WHERE key = ? AND deleted_at IS NULL
     LIMIT 1`,
  )
    .bind(flagKey)
    .first<LegacyFlagRow>()
    .catch(() => null);

  if (!row || row.key === null) return null;

  return {
    enabled: row.enabled_v2 === null ? fallback.default_enabled : row.enabled_v2 === 1,
    rollout_percent: row.rollout_percent ?? fallback.default_rollout_percent,
    stage: row.stage ?? fallback.stage,
    source: 'legacy',
  };
}

/**
 * Resolve a flag's final state given scope. Cached 60s in KV under
 * `flag:<key>:<scopeHash>` so hot-path endpoints aren't hammering D1.
 *
 * Killswitch stage forces `enabled=false` regardless of override or rollout.
 */
export async function resolveFlag(
  env: Env,
  flagKey: string,
  scope: FlagScope = {},
): Promise<FlagState> {
  const def = FLAG_REGISTRY[flagKey];
  if (!def)
    return { enabled: false, rollout_percent: 0, stage: 'experimental', source: 'registry' };
  if (def.stage === 'killswitch')
    return { enabled: false, rollout_percent: 0, stage: 'killswitch', source: 'registry' };

  const cacheKey = `flag:${flagKey}:${scope.siteId ?? ''}:${scope.orgId ?? ''}`;
  const cached = await env.CACHE_KV.get(cacheKey, 'json').catch(() => null);
  if (cached) return cached as FlagState;

  // Tenant override wins
  if (scope.siteId) {
    const row = await fetchOverride(env, 'tenant', scope.siteId, flagKey);
    if (row) {
      const state = parseOverride(row, def, 'tenant');
      await env.CACHE_KV.put(cacheKey, JSON.stringify(state), { expirationTtl: KV_TTL }).catch(
        () => {},
      );
      return state;
    }
  }

  if (scope.orgId) {
    const row = await fetchOverride(env, 'org', scope.orgId, flagKey);
    if (row) {
      const state = parseOverride(row, def, 'org');
      await env.CACHE_KV.put(cacheKey, JSON.stringify(state), { expirationTtl: KV_TTL }).catch(
        () => {},
      );
      return state;
    }
  }

  const globalRow = await fetchOverride(env, 'global', '*', flagKey);
  if (globalRow) {
    const state = parseOverride(globalRow, def, 'global');
    await env.CACHE_KV.put(cacheKey, JSON.stringify(state), { expirationTtl: KV_TTL }).catch(
      () => {},
    );
    return state;
  }

  // No `flag_overrides` row at any scope — fall back to the legacy table's
  // migration-0656-backfilled shape (step 4) before the registry default
  // (step 5). Read-only; never out-ranks a `flag_overrides` row above.
  const legacyState = await resolveLegacyFlagShape(env, flagKey, def);
  if (legacyState) {
    await env.CACHE_KV.put(cacheKey, JSON.stringify(legacyState), {
      expirationTtl: KV_TTL,
    }).catch(() => {});
    return legacyState;
  }

  const fallback: FlagState = {
    enabled: def.default_enabled,
    rollout_percent: def.default_rollout_percent,
    stage: def.stage,
    source: 'registry',
  };
  await env.CACHE_KV.put(cacheKey, JSON.stringify(fallback), { expirationTtl: KV_TTL }).catch(
    () => {},
  );
  return fallback;
}

/**
 * Boolean shortcut. Applies rollout-percent gate via stable user/anon hash.
 * Returns `false` for unknown flags (fail-closed) — never leak feature
 * existence by surfacing `true` for a never-registered key.
 */
export async function isFlagOn(env: Env, flagKey: string, scope: FlagScope = {}): Promise<boolean> {
  const state = await resolveFlag(env, flagKey, scope);
  if (!state.enabled) return false;
  if (state.rollout_percent >= 100) return true;
  if (state.rollout_percent <= 0) return false;
  const hashSource = scope.userId ?? scope.anonId ?? scope.siteId ?? scope.orgId ?? 'anon';
  const hash = await stableHashPercent(`${flagKey}:${hashSource}`);
  return hash < state.rollout_percent;
}

/**
 * Convert any string to a deterministic 0-99 bucket via SHA-1 first 4 bytes.
 * Stable across requests for the same input — same user always lands in
 * the same bucket for a given flag key.
 */
async function stableHashPercent(input: string): Promise<number> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  const view = new DataView(hash);
  const value = view.getUint32(0, false);
  return value % 100;
}

export async function invalidateFlagCache(env: Env, flagKey: string): Promise<void> {
  // KV `list` is paginated (≤1000 keys/page). Walk EVERY page via the cursor so a
  // flag cached across >1000 (siteId,orgId) scopes is FULLY busted on an admin
  // toggle — deleting only the first page would leave later scopes serving the
  // stale value until their 60s TTL lapses (a laggy toggle for large tenants).
  const prefix = `flag:${flagKey}:`;
  let cursor: string | undefined;
  for (;;) {
    const page = await env.CACHE_KV.list({ prefix, cursor }).catch(() => null);
    if (!page) return; // list failed → the 60s TTL is the backstop
    await Promise.all((page.keys ?? []).map((k) => env.CACHE_KV.delete(k.name).catch(() => {})));
    // Real KV always sets `list_complete`; a mock/absent field ends the sweep too.
    if (page.list_complete !== false) return;
    cursor = page.cursor;
  }
}

export { FLAG_REGISTRY } from './registry.js';
