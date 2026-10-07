import {
  superAdminFlagsFixture,
  flagDetailFixture,
  flagAuditFixture,
  detailForKey,
  auditForKey,
  DETAIL_FLAG_KEY,
  type SuperAdminFlagsResponse,
  type FlagDetailResponse,
  type FlagAuditResponse,
} from './feature-flags.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * feature-flags.fixture — the mock bodies for the **Feature Flags** admin section
 * (`/admin/feature-flags`, the System Administrator / Layer-1 control plane). The LIST
 * read (`GET /feature-flags`) is already fixtured by `hosting.fixture.ts` and is NOT
 * retested here. This module covers the THREE reads the component fires on card expand /
 * spec open, all typed to the worker wire EXACTLY:
 *
 *   GET /super-admin/feature-flags             → { flags: { key; enabled_globally:0|1; rollout_pct; kill_switch:0|1; updated_at }[] }
 *   GET /feature-flags/:key                    → { definition; resolved; docs: FlagDocs | null }
 *   GET /super-admin/feature-flags/:key/audit  → { entries: AuditEntry[] }
 *
 * These specs test the factories DIRECTLY (envelope shape · every state · the worker's
 * numeric 0|1 override shape · the FLAG_DOCS block · the AuditEntry mapped shape) and
 * assert all three registry keys resolve through the interceptor's normalizer (query
 * stripped, `:param` patterns matched, the EXACT super-admin key never shadowed by the
 * `:key/audit` pattern). The wiring block reads the STATIC `FIXTURES` map directly (not
 * `findFixture`) so it's immune to Jasmine spec-order + the mutable registerFixtures seam
 * (per the #35 fix). RED until `index.ts` adds the three lines (the orchestrator's merge),
 * then GREEN.
 */

// ─────────────────── GET /super-admin/feature-flags ───────────────────

describe('superAdminFlagsFixture (envelope { flags }, worker legacy 0|1 override shape)', () => {
  it('returns the worker envelope shape { flags: SuperAdminFlagOverrideRow[] }', () => {
    const res: SuperAdminFlagsResponse = superAdminFlagsFixture('populated', new URLSearchParams());
    expect(Array.isArray(res.flags)).toBe(true);
    expect(res.flags.length).toBeGreaterThan(0);
  });

  it('every override row matches the legacy numeric wire (enabled_globally + kill_switch are 0|1)', () => {
    const res = superAdminFlagsFixture('populated', new URLSearchParams());
    for (const r of res.flags) {
      expect(typeof r.key).toBe('string');
      // SQLite booleans on the wire — strictly 0 or 1, NOT JS booleans.
      expect([0, 1]).toContain(r.enabled_globally);
      expect([0, 1]).toContain(r.kill_switch);
      expect(typeof r.rollout_pct).toBe('number');
      expect(typeof r.updated_at).toBe('string');
    }
  });

  it('only carries rows whose state DIFFERS from the registry default (incl. the featured flag)', () => {
    const res = superAdminFlagsFixture('populated', new URLSearchParams());
    const keys = res.flags.map((f) => f.key);
    // The detail flag has a global override (promoted to 100%) so the list card shows the D1 chip.
    expect(keys).toContain(DETAIL_FLAG_KEY);
    const wfp = res.flags.find((f) => f.key === DETAIL_FLAG_KEY)!;
    expect(wfp.enabled_globally).toBe(1);
    expect(wfp.rollout_pct).toBe(100);
  });

  it('empty → { flags: [] } (no global overrides set → every card stays at its registry default)', () => {
    expect(superAdminFlagsFixture('empty', new URLSearchParams()).flags.length).toBe(0);
  });

  it('loading / default serve the same rows as populated', () => {
    expect(superAdminFlagsFixture('loading', new URLSearchParams()).flags.length).toBe(
      superAdminFlagsFixture('populated', new URLSearchParams()).flags.length,
    );
  });

  it('returns a fresh clone each call (mutating one row never corrupts the next)', () => {
    const a = superAdminFlagsFixture('populated', new URLSearchParams());
    (a.flags[0] as { rollout_pct: number }).rollout_pct = -999;
    const b = superAdminFlagsFixture('populated', new URLSearchParams());
    expect(b.flags[0]!.rollout_pct).not.toBe(-999);
  });
});

// ─────────────────────── GET /feature-flags/:key ───────────────────────

describe('flagDetailFixture (envelope { definition, resolved, docs }, worker-contract-shaped)', () => {
  it('returns the worker envelope { definition; resolved; docs } for the featured flag', () => {
    const res: FlagDetailResponse = flagDetailFixture('populated', new URLSearchParams());
    expect(res.definition.key).toBe(DETAIL_FLAG_KEY);
    expect(typeof res.definition.default_enabled).toBe('boolean');
    expect(typeof res.definition.default_rollout_percent).toBe('number');
    expect(typeof res.definition.owner_email).toBe('string');
  });

  it('resolved carries enabled + rollout_percent + a scope source', () => {
    const r = flagDetailFixture('populated', new URLSearchParams()).resolved;
    expect(typeof r.enabled).toBe('boolean');
    expect(typeof r.rollout_percent).toBe('number');
    expect(['registry', 'global', 'org', 'tenant']).toContain(r.source);
    // The featured flag has a GLOBAL override, so resolution wins there (not the registry default).
    expect(r.source).toBe('global');
  });

  it('docs is the full FLAG_DOCS block (checklist + explanation + smoke_test, rich enough to render)', () => {
    const docs = flagDetailFixture('populated', new URLSearchParams()).docs!;
    expect(docs).not.toBeNull();
    expect(Array.isArray(docs.checklist)).toBe(true);
    expect(docs.checklist.length).toBeGreaterThanOrEqual(3);
    expect(typeof docs.explanation).toBe('string');
    expect(docs.explanation.length).toBeGreaterThan(40);
    expect(Array.isArray(docs.smoke_test)).toBe(true);
    expect(docs.smoke_test.length).toBeGreaterThan(0);
    // Optional blocks the expander + spec sheet render when present.
    expect(Array.isArray(docs.e2e_tests)).toBe(true);
    expect(Array.isArray(docs.references)).toBe(true);
  });

  it('empty → same definition/resolved but docs:null (the registry-description fallback edge)', () => {
    const res = flagDetailFixture('empty', new URLSearchParams());
    expect(res.docs).toBeNull();
    expect(res.definition.key).toBe(DETAIL_FLAG_KEY);
  });

  it('detailForKey(featured) returns the bespoke body; another key reuses it with its key swapped', () => {
    expect(detailForKey(DETAIL_FLAG_KEY).definition.key).toBe(DETAIL_FLAG_KEY);
    const other = detailForKey('some_other_flag');
    expect(other.definition.key).toBe('some_other_flag');
    expect(other.docs).not.toBeNull(); // still renders a full panel
  });

  it('detailForKey(null / unknown) never throws (a demo expand/deep-link always renders)', () => {
    expect(() => detailForKey(null)).not.toThrow();
    expect(() => detailForKey('does-not-exist')).not.toThrow();
    expect(typeof detailForKey(null).definition.key).toBe('string');
  });

  it('returns a fresh clone each call (mutating the checklist never corrupts the next)', () => {
    const a = flagDetailFixture('populated', new URLSearchParams());
    a.docs!.checklist.push('MUTATED');
    const b = flagDetailFixture('populated', new URLSearchParams());
    expect(b.docs!.checklist).not.toContain('MUTATED');
  });
});

// ──────────────── GET /super-admin/feature-flags/:key/audit ────────────────

describe('flagAuditFixture (envelope { entries }, worker AuditEntry mapped shape)', () => {
  it('returns the worker envelope { entries: AuditEntry[] }', () => {
    const res: FlagAuditResponse = flagAuditFixture('populated', new URLSearchParams());
    expect(Array.isArray(res.entries)).toBe(true);
    expect(res.entries.length).toBeGreaterThan(0);
  });

  it('every entry matches the mapped shape (id / actor / action / summary / created_at)', () => {
    const res = flagAuditFixture('populated', new URLSearchParams());
    for (const e of res.entries) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.actor).toBe('string');
      expect(typeof e.action).toBe('string');
      expect(typeof e.summary).toBe('string');
      expect(typeof e.created_at).toBe('string');
      // reason is optional (nullable) — only dangerous changes carry one.
      expect('reason' in e).toBe(true);
    }
  });

  it('is newest-first (created_at DESC — the worker ordering the timeline relies on)', () => {
    const res = flagAuditFixture('populated', new URLSearchParams());
    for (let i = 1; i < res.entries.length; i++) {
      expect(Date.parse(res.entries[i - 1]!.created_at)).toBeGreaterThanOrEqual(
        Date.parse(res.entries[i]!.created_at),
      );
    }
  });

  it('dangerous changes (killswitch) carry a typed reason; routine rollout bumps leave it null', () => {
    const res = flagAuditFixture('populated', new URLSearchParams());
    const killed = res.entries.find((e) => e.summary.includes('kill switch → on'));
    expect(killed).toBeDefined();
    expect(typeof killed!.reason).toBe('string');
    expect(killed!.reason!.length).toBeGreaterThan(4);
    const routine = res.entries.find((e) => e.summary === 'rollout → 25%');
    expect(routine).toBeDefined();
    expect(routine!.reason).toBeNull();
  });

  it('empty → { entries: [] } (a never-overridden flag → the timeline empty state)', () => {
    expect(flagAuditFixture('empty', new URLSearchParams()).entries.length).toBe(0);
  });

  it('auditForKey(featured) returns the arc; any other key gets an empty history', () => {
    expect(auditForKey(DETAIL_FLAG_KEY).length).toBeGreaterThan(0);
    expect(auditForKey('some_other_flag').length).toBe(0);
  });

  it('auditForKey(null) never throws', () => {
    expect(() => auditForKey(null)).not.toThrow();
  });

  it('returns a fresh clone each call (mutating one entry never corrupts the next)', () => {
    const a = flagAuditFixture('populated', new URLSearchParams());
    (a.entries[0] as { summary: string }).summary = 'MUTATED';
    const b = flagAuditFixture('populated', new URLSearchParams());
    expect(b.entries[0]!.summary).not.toBe('MUTATED');
  });
});

// ──────────────────────────── registry wiring ────────────────────────────

describe('feature-flags fixtures — registry wiring (the shipped FIXTURES map carries all three keys)', () => {
  // Read the STATIC registry map directly (NOT findFixture) — the merged lines always carry
  // these factories regardless of Jasmine's spec order, and reading the map never touches the
  // mutable registerFixtures/EXTRA_FIXTURES seam a sibling spec could leak under random order (#35).
  const reg = FIXTURES as Record<string, unknown>;
  const OVERRIDES_KEY = 'GET /super-admin/feature-flags';
  const DETAIL_KEY = 'GET /feature-flags/:key';
  const AUDIT_KEY = 'GET /super-admin/feature-flags/:key/audit';

  it('all three URLs normalize to their registry keys (query stripped; :param segments shaped)', () => {
    expect(
      toRegistryKey('GET', 'https://projectsites.dev/api/super-admin/feature-flags').key,
    ).toBe(OVERRIDES_KEY);
    expect(
      toRegistryKey('GET', `https://projectsites.dev/api/feature-flags/${DETAIL_FLAG_KEY}?org_id=o1`).key,
    ).toBe(`GET /feature-flags/${DETAIL_FLAG_KEY}`);
    expect(
      toRegistryKey('GET', `https://projectsites.dev/api/super-admin/feature-flags/${DETAIL_FLAG_KEY}/audit`).key,
    ).toBe(`GET /super-admin/feature-flags/${DETAIL_FLAG_KEY}/audit`);
  });

  it('GET /super-admin/feature-flags is wired to superAdminFlagsFixture in FIXTURES', () => {
    expect(typeof reg[OVERRIDES_KEY]).toBe('function');
    expect(reg[OVERRIDES_KEY]).toBe(superAdminFlagsFixture as unknown);
  });

  it('GET /feature-flags/:key is wired to flagDetailFixture in FIXTURES', () => {
    expect(typeof reg[DETAIL_KEY]).toBe('function');
    expect(reg[DETAIL_KEY]).toBe(flagDetailFixture as unknown);
  });

  it('GET /super-admin/feature-flags/:key/audit is wired to flagAuditFixture in FIXTURES', () => {
    expect(typeof reg[AUDIT_KEY]).toBe('function');
    expect(reg[AUDIT_KEY]).toBe(flagAuditFixture as unknown);
  });

  it('the EXACT super-admin key is distinct from the :key/audit PATTERN (3 vs 4 segments, never shadowed)', () => {
    expect(OVERRIDES_KEY).not.toBe(AUDIT_KEY);
    expect(reg[OVERRIDES_KEY]).not.toBe(reg[AUDIT_KEY]);
  });

  it('does NOT duplicate the already-done GET /feature-flags LIST route (owned by hosting.fixture.ts)', () => {
    // Our detail key is the :param variant; the bare list key must stay the hosting fixture's.
    expect(DETAIL_KEY).not.toBe('GET /feature-flags');
  });
});
