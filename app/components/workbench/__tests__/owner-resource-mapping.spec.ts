/**
 * @file Owner-grade resource mapping contract (fire-60 — the lone-mountain-global lying-empty fix).
 *
 * ROOT CAUSE LOCKED: the worker used to return camelCase `ResourceRecord[]` while this panel's
 * wire contract reads snake_case — every `resource_kind` was `undefined`, so EVERY per-kind tile
 * counted 0 and all real rows fell into the catch-all with "Unknown" chips (4 real rows: the
 * per-site D1, KV, R2 and the WfP production slot). The worker now emits owner-grade snake_case
 * rows (`owner_inventory.ts`); this spec locks the CLIENT half of the contract:
 *
 *  1. Every owner-grade wire kind buckets into a REAL summary tile — never the `other` catch-all.
 *  2. The WfP slot (`wfp_worker`) and the serving kinds (`hostname` / `routing`) have dedicated,
 *     non-drill tiles (no doomed click — the worker's detail endpoint doesn't serve them).
 *  3. The overview card renders `owner_label` + `display_name` and keeps advanced ids behind a
 *     disclosure; openable gating is restricted to adapter-served kinds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KIND_SPECS, specForKind } from '../NamespaceSummary';

/** Every wire kind the worker's owner inventory can emit (owner_inventory.ts WIRE_KIND_ORDER). */
const WIRE_KINDS = [
  'd1',
  'kv',
  'r2',
  'wfp_worker',
  'durable_object',
  'workflow',
  'queue',
  'vectorize',
  'analytics_engine',
  'connection',
  'hostname',
  'routing',
] as const;

describe('NamespaceSummary kind mapping (owner-grade wire kinds)', () => {
  it('buckets every owner-grade wire kind into a REAL tile — never the other/unknown catch-all', () => {
    for (const kind of WIRE_KINDS) {
      const spec = specForKind(kind);
      expect(spec.key, `wire kind "${kind}" fell into the catch-all`).not.toBe('other');
      expect(spec.label.toLowerCase()).not.toContain('unknown');
    }
  });

  it('maps the WfP slot to the Site Workers tile and serving kinds to Domains & Routing', () => {
    expect(specForKind('wfp_worker').key).toBe('worker');
    expect(specForKind('hostname').key).toBe('domain');
    expect(specForKind('routing').key).toBe('domain');
  });

  it('keeps the canonical store kinds on their own tiles (regression for the 0-count bug)', () => {
    expect(specForKind('d1').key).toBe('d1');
    expect(specForKind('kv').key).toBe('kv');
    expect(specForKind('r2').key).toBe('r2');
    expect(specForKind('durable_object').key).toBe('durable_object');
  });

  it('marks the no-endpoint kinds as noDrill so a tile is never a doomed click', () => {
    expect(specForKind('wfp_worker').noDrill).toBe(true);
    expect(specForKind('hostname').noDrill).toBe(true);
    // Adapter-served kinds stay drillable.
    expect(specForKind('d1').noDrill).toBeFalsy();
  });

  it('a snake_case-less entry (the old camelCase bug) would still land somewhere visible', () => {
    // undefined/empty kind → the catch-all (visible as Other), never dropped silently.
    expect(specForKind('').key).toBe('other');
  });

  it('keeps the canonical tile census complete (every kind row always renders)', () => {
    expect(KIND_SPECS.length).toBeGreaterThanOrEqual(12);
  });
});

describe('ResourceOverviewPanel owner-grade rendering contract', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'ResourceOverviewPanel.tsx'),
    'utf8',
  );

  it('renders the owner label + display name (never a raw concept-only headline)', () => {
    expect(SRC).toMatch(/entry\.owner_label/);
    expect(SRC).toMatch(/entry\.display_name/);
  });

  it('keeps advanced ids behind a disclosure', () => {
    expect(SRC).toMatch(/resources-advanced-detail/);
    expect(SRC).toMatch(/<details/);
    expect(SRC).toMatch(/entry\.detail/);
  });

  it('gates drill-in opening on the adapter-served kinds only', () => {
    expect(SRC).toMatch(/DETAIL_KINDS/);
    expect(SRC).toMatch(/DETAIL_KINDS\.has\(entry\.resource_kind\)/);
  });
});
