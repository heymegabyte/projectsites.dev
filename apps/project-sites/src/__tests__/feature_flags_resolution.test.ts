/**
 * Direct unit coverage for the feature-flag RESOLUTION ENGINE
 * (`src/modules/feature_flags/services.ts`) — the core of the whole flag system,
 * previously only exercised indirectly (other specs mock `isFlagOn`). Tests the
 * REAL functions against KV + D1 stubs:
 *
 *   resolveFlag         — unknown→fail-closed (no I/O), KV cache hit (no D1),
 *                         cache-miss→registry fallback (writes cache), and
 *                         override precedence tenant > org > global.
 *   isFlagOn            — disabled→false, rollout 100→true, 0→false,
 *                         partial→deterministic per scope hash.
 *   invalidateFlagCache — lists `flag:<key>:` + deletes every match
 *                         (the cache-bust contract the admin override-write path
 *                         must call; see UNFINISHED_FEATURES §11m).
 */

import {
  resolveFlag,
  isFlagOn,
  invalidateFlagCache,
  FLAG_REGISTRY,
} from '../modules/feature_flags/services.js';

type Opts = { cacheGet?: unknown; overrideRow?: unknown; listKeys?: string[] };

function makeEnv(opts: Opts = {}) {
  const puts: Array<{ key: string }> = [];
  const deletes: string[] = [];
  const prepares: string[] = [];
  let listPrefix = '';

  const stmt = {
    bind: () => stmt,
    first: async () => opts.overrideRow ?? null,
    run: async () => ({}),
    all: async () => ({ results: [] }),
  };
  const env = {
    CACHE_KV: {
      get: async () => opts.cacheGet ?? null,
      put: async (key: string) => {
        puts.push({ key });
      },
      list: async ({ prefix }: { prefix: string }) => {
        listPrefix = prefix;
        return { keys: (opts.listKeys ?? []).map((name) => ({ name })) };
      },
      delete: async (name: string) => {
        deletes.push(name);
      },
    },
    DB: { prepare: (sql: string) => (prepares.push(sql), stmt) },
  } as never;

  return { env, puts, deletes, prepares, getListPrefix: () => listPrefix };
}

const overrideRow = (v: Record<string, unknown>) => ({ value_json: JSON.stringify(v) });
// A guaranteed-registered flag to drive cache/override branches (resolveFlag
// short-circuits unknown keys BEFORE any cache/DB access).
const KNOWN = 'core_auth';

describe('resolveFlag', () => {
  it('fail-closes an unknown flag without touching KV or D1', async () => {
    const { env, prepares, puts } = makeEnv();
    const state = await resolveFlag(env, 'totally_unknown_flag_xyz', { siteId: 's1' });
    expect(state).toEqual({
      enabled: false,
      rollout_percent: 0,
      stage: 'experimental',
      source: 'registry',
    });
    expect(prepares).toHaveLength(0); // no override lookups
    expect(puts).toHaveLength(0); // nothing cached
  });

  it('returns the cached state on a KV hit without hitting D1', async () => {
    const cached = { enabled: true, rollout_percent: 42, stage: 'beta', source: 'org' };
    const { env, prepares } = makeEnv({ cacheGet: cached });
    const state = await resolveFlag(env, KNOWN, { orgId: 'o1' });
    expect(state).toEqual(cached);
    expect(prepares).toHaveLength(0); // cache short-circuits the D1 override lookup
  });

  it('falls back to the registry default on a cache miss + writes the cache', async () => {
    const { env, puts } = makeEnv({ cacheGet: null, overrideRow: null });
    const state = await resolveFlag(env, KNOWN, {});
    const def = FLAG_REGISTRY[KNOWN];
    expect(state).toEqual({
      enabled: def.default_enabled,
      rollout_percent: def.default_rollout_percent,
      stage: def.stage,
      source: 'registry',
    });
    expect(puts.length).toBeGreaterThan(0); // result is cached for the hot path
  });

  it('lets a TENANT override win (source=tenant) over the registry default', async () => {
    const { env } = makeEnv({
      overrideRow: overrideRow({ enabled: false, rollout_percent: 0, stage: 'killswitch' }),
    });
    const state = await resolveFlag(env, KNOWN, { siteId: 's1', orgId: 'o1' });
    expect(state.source).toBe('tenant');
    expect(state.enabled).toBe(false);
    expect(state.stage).toBe('killswitch');
  });

  it('applies an ORG override when no tenant scope is given', async () => {
    const { env } = makeEnv({ overrideRow: overrideRow({ enabled: true, rollout_percent: 25 }) });
    const state = await resolveFlag(env, KNOWN, { orgId: 'o1' });
    expect(state.source).toBe('org');
    expect(state.rollout_percent).toBe(25);
  });

  it('applies a GLOBAL override when no tenant/org scope is given', async () => {
    const { env } = makeEnv({ overrideRow: overrideRow({ enabled: true, rollout_percent: 10 }) });
    const state = await resolveFlag(env, KNOWN, {});
    expect(state.source).toBe('global');
  });

  // ── Governance-table independence (fire-302) ──────────────────────────────
  // Locks the PRIMARY contract: resolution is driven by the CODE registry +
  // `flag_overrides`, NOT by the governance `feature_flags` D1 table (the
  // /admin/feature-flags catalog row). A `feature_flags` row that DIVERGES from
  // the registry default — WITHOUT a matching `flag_overrides` row — has ZERO
  // effect: `resolveFlag` returns the REGISTRY default and never even SELECTs
  // the governance table. Proof in services.ts: the ONLY D1 read is
  // `fetchOverride` (`SELECT … FROM flag_overrides …`); the fallback is
  // `def.default_enabled` from FLAG_REGISTRY. There is no code path that reads
  // a `feature_flags` row into the resolved state.
  const REGISTRY_DISABLED = 'claim_flow'; // registry default: enabled:false, rollout:0

  it('IGNORES a divergent governance `feature_flags` row — returns the registry default, never queries feature_flags', async () => {
    // Registry says claim_flow is OFF. There is NO flag_overrides row
    // (overrideRow:null). A governance `feature_flags` row claiming enabled:true
    // is deliberately NOT modeled here precisely BECAUSE the resolver never reads
    // it — the stub only answers `flag_overrides` SELECTs (→ null). If the
    // resolver were (wrongly) driven by the governance table, there would be a
    // SELECT against `feature_flags`; we assert there is not.
    const { env, prepares } = makeEnv({ cacheGet: null, overrideRow: null });
    const def = FLAG_REGISTRY[REGISTRY_DISABLED];
    expect(def.default_enabled).toBe(false); // guard: anchor flag really is registry-disabled

    const state = await resolveFlag(env, REGISTRY_DISABLED, { siteId: 's1', orgId: 'o1' });

    // Resolution tracks the CODE registry, not any governance row.
    expect(state).toEqual({
      enabled: def.default_enabled, // false — the registry default wins
      rollout_percent: def.default_rollout_percent,
      stage: def.stage,
      source: 'registry', // NOT 'global'/'org'/'tenant' — no override, no governance read
    });

    // The ONLY D1 reads are override lookups against `flag_overrides`; the
    // governance `feature_flags` table is NEVER queried by the resolver.
    expect(prepares.length).toBeGreaterThan(0); // it DID hit D1 (for overrides)…
    for (const sql of prepares) expect(sql).toContain('flag_overrides');
    expect(prepares.some((sql) => /\bfeature_flags\b/.test(sql))).toBe(false);
  });
});

describe('isFlagOn (rollout gating)', () => {
  it('false when the resolved state is disabled', async () => {
    const { env } = makeEnv({
      cacheGet: { enabled: false, rollout_percent: 100, stage: 'beta', source: 'global' },
    });
    expect(await isFlagOn(env, KNOWN, { userId: 'u1' })).toBe(false);
  });

  it('true at 100% rollout', async () => {
    const { env } = makeEnv({
      cacheGet: { enabled: true, rollout_percent: 100, stage: 'stable', source: 'global' },
    });
    expect(await isFlagOn(env, KNOWN, { userId: 'u1' })).toBe(true);
  });

  it('false at 0% rollout even when enabled', async () => {
    const { env } = makeEnv({
      cacheGet: { enabled: true, rollout_percent: 0, stage: 'beta', source: 'global' },
    });
    expect(await isFlagOn(env, KNOWN, { userId: 'u1' })).toBe(false);
  });

  it('is deterministic per scope at a partial rollout', async () => {
    const cacheGet = { enabled: true, rollout_percent: 50, stage: 'beta', source: 'global' };
    const a = await isFlagOn(makeEnv({ cacheGet }).env, KNOWN, { userId: 'stable-user' });
    const b = await isFlagOn(makeEnv({ cacheGet }).env, KNOWN, { userId: 'stable-user' });
    expect(typeof a).toBe('boolean');
    expect(a).toBe(b); // same user → same bucket → same answer
  });
});

describe('invalidateFlagCache', () => {
  it('lists the flag:<key>: prefix and deletes every matching cache entry', async () => {
    const { env, deletes, getListPrefix } = makeEnv({
      listKeys: ['flag:my_flag:s1:o1', 'flag:my_flag::', 'flag:my_flag::o2'],
    });
    await invalidateFlagCache(env, 'my_flag');
    expect(getListPrefix()).toBe('flag:my_flag:');
    expect(deletes).toEqual(['flag:my_flag:s1:o1', 'flag:my_flag::', 'flag:my_flag::o2']);
  });

  it('no-ops cleanly when nothing is cached', async () => {
    const { env, deletes } = makeEnv({ listKeys: [] });
    await expect(invalidateFlagCache(env, 'my_flag')).resolves.toBeUndefined();
    expect(deletes).toEqual([]);
  });

  it('walks EVERY KV page via the cursor so >1000-scope flags fully bust', async () => {
    // Real KV paginates at 1000 keys/page. A single-page delete would leave later
    // scopes serving the stale value until their TTL lapses — so the sweep must
    // follow `cursor` until `list_complete`.
    const deletes: string[] = [];
    const listCursors: Array<string | undefined> = [];
    const pages = [
      { keys: [{ name: 'flag:big:a:1' }], list_complete: false, cursor: 'c1' },
      { keys: [{ name: 'flag:big:b:2' }], list_complete: true },
    ];
    let call = 0;
    const env = {
      CACHE_KV: {
        list: async ({ cursor }: { prefix: string; cursor?: string }) => {
          listCursors.push(cursor);
          return pages[call++];
        },
        delete: async (name: string) => {
          deletes.push(name);
        },
      },
    } as never;

    await invalidateFlagCache(env, 'big');

    expect(call).toBe(2); // both pages walked
    expect(listCursors).toEqual([undefined, 'c1']); // 2nd list used the 1st page's cursor
    expect(deletes).toEqual(['flag:big:a:1', 'flag:big:b:2']); // keys from BOTH pages deleted
  });
});
