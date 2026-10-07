import { auditFixture, type AuditLogsResponse } from './audit.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * audit.fixture — the mock body for GET /api/audit-logs (the admin `/admin/audit`
 * forensics grid + the Logs "Audit Trail" tab).
 *
 * Contract (traced to `libs/features/audit_logs/handlers.ts`):
 *   `{ data: AuditRow[], meta: { limit, offset, total, has_more,
 *      stats: { unique_actions, actors, last_24h } } }`
 *
 * The component (`audit.component.ts`) reads `r.data` for the grid and
 * `r.meta.total` + `r.meta.stats` for the KPI cards (TRUE full-set aggregates,
 * independent of the ≤500-row page). This spec tests the factory DIRECTLY —
 * shape + every state + offset/limit pagination parity with the worker.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('auditFixture (worker-contract-shaped, paginated, state variants)', () => {
  it('returns the worker envelope shape { data, meta{limit,offset,total,has_more,stats} }', () => {
    const res: AuditLogsResponse = auditFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(typeof res.meta.limit).toBe('number');
    expect(typeof res.meta.offset).toBe('number');
    expect(typeof res.meta.total).toBe('number');
    expect(typeof res.meta.has_more).toBe('boolean');
    expect(typeof res.meta.stats.unique_actions).toBe('number');
    expect(typeof res.meta.stats.actors).toBe('number');
    expect(typeof res.meta.stats.last_24h).toBe('number');
  });

  it('ships 30+ believable rows so the grid pagination/scroll is exercised', () => {
    const res = auditFixture('populated', q());
    expect(res.meta.total).toBeGreaterThanOrEqual(30);
  });

  it('each row matches the AuditRow contract (nullable fields; metadata object|null)', () => {
    const { data } = auditFixture('populated', q('limit=500'));
    for (const r of data) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.action).toBe('string');
      expect(typeof r.created_at).toBe('string');
      // metadata is an OBJECT or null (never a JSON string — the worker JSON.parses it).
      expect(r.metadata === null || (typeof r.metadata === 'object' && !Array.isArray(r.metadata))).toBe(true);
      // message / target_* / actor_id / request_id / site are string|null.
      for (const k of ['message', 'target_type', 'target_id', 'actor_id', 'request_id', 'site'] as const) {
        expect(r[k] === null || typeof r[k] === 'string').toBe(true);
      }
    }
  });

  it('is ordered newest-first (mirrors the worker ORDER BY created_at DESC)', () => {
    // The store is built ONCE at module load, dating each row `Date.now() - minutesAgo` with
    // Date.now() called PER ROW. Compare at WHOLE-SECOND granularity so a sub-millisecond build
    // jitter between two rows can never flake the strict `>=` (today every seed differs by ≥60s,
    // but a future tie must stay deterministic). Still proves the DESC ordering the component relies on.
    const { data } = auditFixture('populated', q('limit=500'));
    const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    for (let i = 1; i < data.length; i++) {
      expect(sec(data[i - 1]!.created_at)).toBeGreaterThanOrEqual(sec(data[i]!.created_at));
    }
  });

  it('has a realistic spread: mixed actions, mixed actors (incl. system/null), some null-metadata, mixed sites', () => {
    const { data } = auditFixture('populated', q('limit=500'));
    expect(new Set(data.map((r) => r.action)).size).toBeGreaterThanOrEqual(8);
    expect(data.some((r) => r.actor_id === null)).toBe(true); // a system actor
    expect(data.some((r) => r.actor_id !== null)).toBe(true);
    expect(data.some((r) => r.metadata === null)).toBe(true);
    expect(data.some((r) => r.metadata !== null)).toBe(true);
    expect(data.some((r) => r.site !== null)).toBe(true); // site-scoped rows
    expect(data.some((r) => r.site === null)).toBe(true); // org-level rows
  });

  it('meta.stats are TRUE full-set aggregates (computed over ALL rows, not a page slice)', () => {
    const full = auditFixture('populated', q('limit=500'));
    const distinctActions = new Set(full.data.map((r) => r.action)).size;
    const distinctActors = new Set(full.data.map((r) => r.actor_id)).size; // null counts as one DISTINCT (SQLite)
    expect(full.meta.stats.unique_actions).toBe(distinctActions);
    expect(full.meta.stats.actors).toBe(distinctActors);
    expect(full.meta.stats.last_24h).toBeGreaterThan(0);
    expect(full.meta.stats.last_24h).toBeLessThanOrEqual(full.meta.total);
  });

  it('honors limit — a page returns at most `limit` rows but the SAME full-set total + stats', () => {
    const full = auditFixture('populated', q('limit=500'));
    const page = auditFixture('populated', q('limit=10'));
    expect(page.data.length).toBe(10);
    expect(page.meta.limit).toBe(10);
    expect(page.meta.total).toBe(full.meta.total); // total is store-wide, never the page length
    expect(page.meta.stats).toEqual(full.meta.stats); // stats are full-set, independent of the page
    expect(page.meta.has_more).toBe(true); // 10 < total
  });

  it('honors offset — page 2 returns the tail slice, no overlap with page 1, same total', () => {
    const page1 = auditFixture('populated', q('offset=0&limit=20'));
    const page2 = auditFixture('populated', q('offset=20&limit=20'));
    expect(page1.meta.total).toBe(page2.meta.total);
    expect(page1.meta.offset).toBe(0);
    expect(page2.meta.offset).toBe(20);
    const ids = new Set([...page1.data, ...page2.data].map((r) => r.id));
    expect(ids.size).toBe(page1.data.length + page2.data.length); // all unique across pages
  });

  it('component default (limit=500, no offset) returns the whole store in one page, has_more false', () => {
    const res = auditFixture('populated', q('limit=500'));
    expect(res.data.length).toBe(res.meta.total);
    expect(res.meta.has_more).toBe(false); // the full store fits the 500-row cap
  });

  it('empty state → 0 rows, total 0, all stats 0 (a real empty variant)', () => {
    const res = auditFixture('empty', q('limit=500'));
    expect(res.data.length).toBe(0);
    expect(res.meta.total).toBe(0);
    expect(res.meta.has_more).toBe(false);
    expect(res.meta.stats).toEqual({ unique_actions: 0, actors: 0, last_24h: 0 });
  });

  it('loading state serves the full populated body (interceptor owns the delay)', () => {
    const loading = auditFixture('loading', q('limit=500'));
    const populated = auditFixture('populated', q('limit=500'));
    expect(loading.data.length).toBe(populated.data.length);
  });

  it('normalizes to the registry key GET /audit-logs + is wired to auditFixture in FIXTURES', () => {
    // Assert against the STATIC registry map directly — the merged key always carries this
    // factory regardless of Jasmine's spec order, and reading the map (not the mutable
    // findFixture/EXTRA_FIXTURES seam a sibling spec could leak) is deterministic.
    const { key } = toRegistryKey('GET', '/api/audit-logs?limit=500');
    expect(key).toBe('GET /audit-logs');
    expect((FIXTURES as Record<string, unknown>)[key]).toBe(auditFixture as unknown);
  });
});
