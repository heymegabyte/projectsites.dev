/**
 * `GET /api/feature-flags` — the admin flags LIST is the UNION of the CODE
 * REGISTRY (SSOT — every flag exists even on a brand-new database) and the D1
 * global override layer (`flag_overrides` scope='global'/scope_id='*'), with
 * D1 winning for enabled/rollout/stage where a row exists. Each entry carries
 * `source: 'registry' | 'd1' | 'override'` so the admin UI can show where the
 * state came from.
 *
 * Fire-57 regression class: a FRESH install (zero D1 rows) must still list
 * EVERY code-defined flag (model_registry included) — the admin Feature Flags
 * page can never render empty just because D1 has no rows yet. Fail-soft: a
 * missing/broken `flag_overrides` table (install mid-migration) serves the
 * registry-only list, never a 500.
 */

import features from '../routes/features.js';
import { FLAG_REGISTRY } from '../modules/feature_flags/registry.js';

interface ListedFlag {
  key: string;
  default_enabled: boolean;
  default_rollout_percent: number;
  stage: string;
  owner_email: string;
  has_docs: boolean;
  source: 'registry' | 'd1' | 'override';
  kill_switch?: boolean;
}

interface ListBody {
  flags: ListedFlag[];
  count: number;
}

type OverrideRow = { flag_key: string; value_json: string };

/** Env stub: D1 whose global-override query returns `rows` (or throws). */
function envWith(rows: OverrideRow[] | 'throw' = []) {
  const chain = {
    bind: () => chain,
    first: async () => null,
    run: async () => ({}),
    all: async () => {
      if (rows === 'throw') throw new Error('no such table: flag_overrides');
      return { results: rows };
    },
  };
  return {
    DB: { prepare: () => chain },
    CACHE_KV: { get: async () => null, put: async () => undefined },
  } as never;
}

const list = async (env: unknown): Promise<ListBody> => {
  const res = await features.request('/api/feature-flags', {}, env as never);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
};

const REGISTRY_COUNT = Object.keys(FLAG_REGISTRY).length;

describe('GET /api/feature-flags — registry ∪ D1 union', () => {
  it('fresh D1 (zero rows) still lists the FULL registry, every entry source-tagged', async () => {
    const body = await list(envWith([]));
    expect(body.count).toBeGreaterThanOrEqual(REGISTRY_COUNT);
    expect(body.count).toBe(body.flags.length);

    const mr = body.flags.find((f) => f.key === 'model_registry');
    expect(mr).toBeDefined();
    expect(mr?.source).toBe('registry');

    // Every entry declares which layer produced its state.
    for (const f of body.flags) {
      expect(['registry', 'd1', 'override']).toContain(f.source);
    }
  });

  it('a D1 global row WINS over the registry default and is tagged source=d1', async () => {
    // model_registry defaults enabled=true/rollout=100 in the code registry —
    // the D1 row must override BOTH plus stage.
    expect(FLAG_REGISTRY['model_registry'].default_enabled).toBe(true);
    const body = await list(
      envWith([
        {
          flag_key: 'model_registry',
          value_json: JSON.stringify({ enabled: false, rollout_percent: 5, stage: 'experimental' }),
        },
      ]),
    );
    const mr = body.flags.find((f) => f.key === 'model_registry');
    expect(mr?.default_enabled).toBe(false);
    expect(mr?.default_rollout_percent).toBe(5);
    expect(mr?.stage).toBe('experimental');
    expect(mr?.source).toBe('d1');

    // A sibling flag with NO row keeps its registry default + tag.
    const sibling = body.flags.find((f) => f.key === 'core_auth');
    expect(sibling?.default_enabled).toBe(FLAG_REGISTRY['core_auth'].default_enabled);
    expect(sibling?.source).toBe('registry');
  });

  it('partial D1 row overrides only its set fields; kill_switch surfaces', async () => {
    const body = await list(
      envWith([{ flag_key: 'model_registry', value_json: JSON.stringify({ kill_switch: true }) }]),
    );
    const mr = body.flags.find((f) => f.key === 'model_registry');
    // Unset fields fall back to registry values, but the row still wins as the layer.
    expect(mr?.default_enabled).toBe(FLAG_REGISTRY['model_registry'].default_enabled);
    expect(mr?.default_rollout_percent).toBe(
      FLAG_REGISTRY['model_registry'].default_rollout_percent,
    );
    expect(mr?.kill_switch).toBe(true);
    expect(mr?.source).toBe('d1');
  });

  it('an invalid stage value in D1 is ignored (registry stage stands)', async () => {
    const body = await list(
      envWith([{ flag_key: 'model_registry', value_json: JSON.stringify({ stage: 'yolo' }) }]),
    );
    expect(body.flags.find((f) => f.key === 'model_registry')?.stage).toBe(
      FLAG_REGISTRY['model_registry'].stage,
    );
  });

  it('malformed value_json falls back to the registry values for that flag', async () => {
    const body = await list(envWith([{ flag_key: 'model_registry', value_json: 'not-json{' }]));
    const mr = body.flags.find((f) => f.key === 'model_registry');
    expect(mr?.default_enabled).toBe(FLAG_REGISTRY['model_registry'].default_enabled);
    expect(mr?.source).toBe('registry');
  });

  it('a missing/broken flag_overrides table fails SOFT to the registry-only list', async () => {
    const body = await list(envWith('throw'));
    expect(body.count).toBeGreaterThanOrEqual(REGISTRY_COUNT);
    expect(body.flags.find((f) => f.key === 'model_registry')?.source).toBe('registry');
  });

  it('a D1 row for a key NOT in the registry does not invent a flag (registry is the SSOT)', async () => {
    const body = await list(
      envWith([{ flag_key: 'ghost_flag_never_registered', value_json: '{"enabled":true}' }]),
    );
    expect(body.flags.find((f) => f.key === 'ghost_flag_never_registered')).toBeUndefined();
    expect(body.count).toBe(REGISTRY_COUNT);
  });
});
