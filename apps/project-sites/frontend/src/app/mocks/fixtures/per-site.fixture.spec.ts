import {
  mcpConnectionsFixture,
  snapshotMetricsFixture,
  snapshotsListFixture,
  githubStatusFixture,
  aiLogsFixture,
  deliverabilityFixture,
  copilotConfigFixture,
  logsTailFixture,
  webhooksFixture,
  webhookDeliveriesFixture,
  sparklineFixture,
  annotationsFixture,
  readinessFixture,
  type McpConnectionsResponse,
  type SnapshotMetricsResponse,
  type SnapshotsListResponse,
  type GithubStatusResponse,
  type AiLogsResponse,
  type DeliverabilityResponse,
  type CopilotConfigResponse,
  type LogsTailResponse,
  type WebhooksResponse,
  type WebhookDeliveriesResponse,
  type SparklineResponse,
  type AnnotationsResponse,
  type ReadinessResponse,
} from './per-site.fixture';
import { findFixture, toRegistryKey } from './index';

/**
 * per-site.fixture — mock bodies for the PER-SITE (`/sites/:id/…`) reads the
 * already-mocked demo surfaces fire once a site is selected, which previously
 * 404'd (the fixture site ids don't exist in prod) and surfaced "Can't reach the
 * server" toasts in the `?mock=1` demo:
 *
 *   GET /sites/:id/mcp/connections   → { data: { providers: string[]; connections: [] } }
 *                                       (billing's refreshSlackConnected fires this per site)
 *   GET /sites/:id/snapshots/metrics → { data: [] }
 *                                       (dashboard's loadLatestMetrics fires this on site-load)
 *
 * Each matches the worker wire contract EXACTLY so the real endpoint is a drop-in
 * swap. The empty-but-well-formed body is the clean demo default — every consumer
 * reads `data.connections ?? []` / `Object.values(data)` and renders a calm
 * "nothing connected yet" / "—" state, so NO spurious error toast fires.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('mcpConnectionsFixture (GET /sites/:id/mcp/connections → { data: { providers, connections } })', () => {
  it('returns the worker envelope shape { data: { providers, connections } }', () => {
    const res: McpConnectionsResponse = mcpConnectionsFixture('populated', q());
    expect(res.data).toBeDefined();
    expect(Array.isArray(res.data.providers)).toBe(true);
    expect(Array.isArray(res.data.connections)).toBe(true);
  });

  it('connections is EMPTY on every state (the clean demo default — nothing connected yet)', () => {
    // No site has a connected provider in the demo → the surface renders its calm
    // "connect your first integration" state, never a spurious error.
    expect(mcpConnectionsFixture('populated', q()).data.connections).toEqual([]);
    expect(mcpConnectionsFixture('empty', q()).data.connections).toEqual([]);
    expect(mcpConnectionsFixture('loading', q()).data.connections).toEqual([]);
  });

  it('providers lists the real catalogue so the connect-picker renders (non-empty, all strings)', () => {
    const { providers } = mcpConnectionsFixture('populated', q()).data;
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) expect(typeof p).toBe('string');
    // A couple of the known adapters the worker's allProviders() emits.
    expect(providers).toContain('stripe');
    expect(providers).toContain('slack');
  });

  it('normalizes to the :param registry key GET /sites/:id/mcp/connections', () => {
    // The pure normalizer yields the concrete key; the param pattern this fixture
    // is registered under matches it (asserted in index.spec.ts).
    expect(toRegistryKey('GET', '/api/sites/site-001/mcp/connections').key).toBe(
      'GET /sites/site-001/mcp/connections',
    );
  });
});

describe('snapshotMetricsFixture (GET /sites/:id/snapshots/metrics → { data: MetricsRow[] })', () => {
  it('returns the worker envelope shape { data: [] } (array, empty in the demo)', () => {
    const res: SnapshotMetricsResponse = snapshotMetricsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toEqual([]);
  });

  it('is empty on every state so the dashboard CWV widget degrades cleanly to "—"', () => {
    expect(snapshotMetricsFixture('empty', q()).data).toEqual([]);
    expect(snapshotMetricsFixture('loading', q()).data).toEqual([]);
  });

  it('normalizes to the :param registry key GET /sites/:id/snapshots/metrics', () => {
    expect(toRegistryKey('GET', '/api/sites/site-002/snapshots/metrics').key).toBe(
      'GET /sites/site-002/snapshots/metrics',
    );
  });
});

// ═══════════════════════ #34 shell sweep — toast-free demo ═══════════════════════
// Eight more per-site reads fired on section/tab open. Fixturing them makes the whole
// ?mock=1 demo toast-free (snapshots + github/status were NON-silent → toasted; the rest
// are silent but kept the demo network tab dirty with 404s). Each is typed to the exact
// worker wire shape and registered under a :param pattern (one body serves every site id).

function registered(key: string): boolean {
  return findFixture(key) !== undefined;
}

describe('snapshotsListFixture (GET /sites/:id/snapshots → { data, git_history })', () => {
  it('returns the worker envelope { data, git_history } (git_history always [] in the demo)', () => {
    const res: SnapshotsListResponse = snapshotsListFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.git_history).toEqual([]);
  });

  it('populated → believable snapshots newest-first (the "initial" is oldest); empty → []', () => {
    const rows = snapshotsListFixture('populated', q()).data;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.snapshot_name).toBe('string');
      expect(typeof r.build_version).toBe('string');
      expect(typeof r.commit_iso).toBe('string');
    }
    expect(snapshotsListFixture('empty', q()).data).toEqual([]);
  });

  it('is registered under the :param key GET /sites/:id/snapshots (NOT shadowed by …/metrics)', () => {
    expect(toRegistryKey('GET', '/api/sites/s-1/snapshots').key).toBe('GET /sites/s-1/snapshots');
    expect(registered('GET /sites/s-1/snapshots')).toBe(true);
    // The longer …/snapshots/metrics key resolves to the DISTINCT metrics fixture (array body).
    const metrics = findFixture('GET /sites/s-1/snapshots/metrics')!('populated', q()) as {
      data: unknown[];
    };
    expect(Array.isArray(metrics.data)).toBe(true);
    // …and the plain snapshots key resolves to the LIST fixture (has git_history).
    const list = findFixture('GET /sites/s-1/snapshots')!('populated', q()) as SnapshotsListResponse;
    expect('git_history' in list).toBe(true);
  });
});

describe('githubStatusFixture (GET /sites/:id/github/status → { data: { connected } })', () => {
  it('always returns { data: { connected: false } } on every state (never fabricates a link)', () => {
    const states = ['populated', 'empty', 'loading'] as const;
    for (const s of states) {
      const res: GithubStatusResponse = githubStatusFixture(s, q());
      expect(res.data.connected).toBe(false);
    }
  });

  it('is registered under the :param key GET /sites/:id/github/status', () => {
    expect(toRegistryKey('GET', '/api/sites/s-1/github/status').key).toBe(
      'GET /sites/s-1/github/status',
    );
    expect(registered('GET /sites/s-1/github/status')).toBe(true);
  });
});

describe('aiLogsFixture (GET /sites/:id/ai-logs → { data, meta })', () => {
  it('returns the worker envelope { data, meta } with a consistent total', () => {
    const res: AiLogsResponse = aiLogsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.meta.total).toBe(res.data.length);
    expect(res.meta.has_more).toBe(false);
  });

  it('populated → believable traces (chat/router/tool); empty → [] with total 0', () => {
    expect(aiLogsFixture('populated', q()).data.length).toBeGreaterThan(0);
    const empty = aiLogsFixture('empty', q());
    expect(empty.data).toEqual([]);
    expect(empty.meta.total).toBe(0);
  });

  it('is registered under the :param key GET /sites/:id/ai-logs', () => {
    expect(registered('GET /sites/s-1/ai-logs')).toBe(true);
  });
});

describe('deliverabilityFixture (GET /sites/:id/deliverability → { ok, report, needsDomain })', () => {
  it('always returns the honest pre-domain surface { ok, report: null, needsDomain: true }', () => {
    const res: DeliverabilityResponse = deliverabilityFixture('populated', q());
    expect(res.ok).toBe(true);
    expect(res.report).toBeNull();
    expect(res.needsDomain).toBe(true);
  });

  it('is registered under the :param key GET /sites/:id/deliverability', () => {
    expect(registered('GET /sites/s-1/deliverability')).toBe(true);
  });
});

describe('copilotConfigFixture (GET /sites/:id/copilot/config → { site_id, enabled })', () => {
  it('returns { site_id, enabled } — enabled on populated, off on empty', () => {
    const on: CopilotConfigResponse = copilotConfigFixture('populated', q());
    expect(on.enabled).toBe(true);
    expect(typeof on.site_id).toBe('string');
    expect(copilotConfigFixture('empty', q()).enabled).toBe(false);
  });

  it('is registered under the :param key GET /sites/:id/copilot/config', () => {
    expect(registered('GET /sites/s-1/copilot/config')).toBe(true);
  });
});

describe('logsTailFixture (GET /sites/:id/logs/tail → { logs })', () => {
  it('returns { logs } — believable tail on populated, [] on empty', () => {
    const res: LogsTailResponse = logsTailFixture('populated', q());
    expect(Array.isArray(res.logs)).toBe(true);
    expect(res.logs.length).toBeGreaterThan(0);
    for (const l of res.logs) {
      expect(typeof l.ts).toBe('string');
      expect(typeof l.message).toBe('string');
    }
    expect(logsTailFixture('empty', q()).logs).toEqual([]);
  });

  it('is registered under the :param key GET /sites/:id/logs/tail', () => {
    expect(registered('GET /sites/s-1/logs/tail')).toBe(true);
  });
});

describe('webhooksFixture + webhookDeliveriesFixture (Settings → Webhooks tab)', () => {
  it('webhooks → { ok: true, endpoints: [] } on every state (honest empty launchpad)', () => {
    const res: WebhooksResponse = webhooksFixture('populated', q());
    expect(res.ok).toBe(true);
    expect(res.endpoints).toEqual([]);
    expect(webhooksFixture('empty', q()).endpoints).toEqual([]);
  });

  it('deliveries → { ok: true, deliveries: [] } on every state', () => {
    const res: WebhookDeliveriesResponse = webhookDeliveriesFixture('populated', q());
    expect(res.ok).toBe(true);
    expect(res.deliveries).toEqual([]);
  });

  it('both are registered under :param keys, and the longer deliveries key is NOT shadowed', () => {
    expect(registered('GET /sites/s-1/webhooks')).toBe(true);
    expect(registered('GET /sites/s-1/webhooks/deliveries')).toBe(true);
    // The anchored :param regex for /webhooks must NOT match /webhooks/deliveries — each
    // resolves to its OWN fixture (both share the same empty shape, so assert via key count).
    expect(toRegistryKey('GET', '/api/sites/s-1/webhooks/deliveries').key).toBe(
      'GET /sites/s-1/webhooks/deliveries',
    );
  });
});

// ═══════════════════ #34 — Snapshots section's three per-site reads ═══════════════════
// The health sparkline, timeline-notes, and readiness panel each self-fetch a per-site GET
// on the Snapshots surface. These were NOT fixtured → 404 in the demo (fixture ids are
// prod-nonexistent). Each must match the EXACT worker wire shape (verified against the live
// handlers), register under a :param key, and — critically — NOT be shadowed by the sibling
// `/sites/:id/snapshots` + `/sites/:id/snapshots/metrics` patterns (anchored regexes).

describe('sparklineFixture (GET /sites/:id/sparkline → { siteId, days })', () => {
  it('returns the worker envelope { siteId, days } (NOT wrapped in { data })', () => {
    const res: SparklineResponse = sparklineFixture('populated', q());
    expect(typeof res.siteId).toBe('string');
    expect(Array.isArray(res.days)).toBe(true);
    for (const d of res.days) {
      expect(typeof d.date).toBe('string');
      expect(typeof d.visits).toBe('number');
    }
  });

  it('populated → a renderable trend (≥2 days AND a non-zero total, the card`s visible gate)', () => {
    const res = sparklineFixture('populated', q());
    expect(res.days.length).toBeGreaterThanOrEqual(2);
    expect(res.days.reduce((s, d) => s + d.visits, 0)).toBeGreaterThan(0);
  });

  it('empty → { days: [] } (no traffic → the card self-hides, honest brand-new state)', () => {
    expect(sparklineFixture('empty', q()).days).toEqual([]);
  });

  it('honors ?days= by returning the LAST N days, clamped to 1..30 (mirrors the worker window)', () => {
    expect(sparklineFixture('populated', q('days=7')).days.length).toBe(7);
    expect(sparklineFixture('populated', q('days=3')).days.length).toBe(3);
    // default (no param) = 7
    expect(sparklineFixture('populated', q()).days.length).toBe(7);
    // clamp: a huge value caps at the available series (≤30); a bad value falls back to 7
    expect(sparklineFixture('populated', q('days=999')).days.length).toBeLessThanOrEqual(30);
    expect(sparklineFixture('populated', q('days=abc')).days.length).toBe(7);
    // the returned slice is the TAIL (most-recent days), newest last
    const three = sparklineFixture('populated', q('days=3')).days;
    expect(three[three.length - 1].date).toBe('2026-10-06');
  });

  it('is registered under :param GET /sites/:id/sparkline and NOT shadowed by /snapshots', () => {
    expect(registered('GET /sites/s-1/sparkline')).toBe(true);
    // the /snapshots + /snapshots/metrics patterns must not swallow /sparkline
    expect(findFixture('GET /sites/s-1/sparkline')).toBe(
      sparklineFixture as unknown as ReturnType<typeof findFixture>,
    );
  });
});

describe('annotationsFixture (GET /sites/:id/annotations → { data })', () => {
  it('returns the worker envelope { data: Annotation[] } with the full row shape', () => {
    const res: AnnotationsResponse = annotationsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    for (const a of res.data) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.siteId).toBe('string');
      expect(typeof a.date).toBe('string');
      expect(typeof a.note).toBe('string');
      expect(typeof a.category).toBe('string');
      expect(typeof a.createdAt).toBe('string');
    }
  });

  it('empty → { data: [] } (the timeline-notes `add a marker` launchpad)', () => {
    expect(annotationsFixture('empty', q()).data).toEqual([]);
  });

  it('is registered under :param GET /sites/:id/annotations', () => {
    expect(registered('GET /sites/s-1/annotations')).toBe(true);
    expect(findFixture('GET /sites/s-1/annotations')).toBe(
      annotationsFixture as unknown as ReturnType<typeof findFixture>,
    );
  });
});

describe('readinessFixture (GET /sites/:id/readiness → { score, grade, checks })', () => {
  it('returns the BARE worker envelope { score, grade, checks } (NOT wrapped in { data })', () => {
    const res: ReadinessResponse = readinessFixture('populated', q());
    expect(typeof res.score).toBe('number');
    expect(typeof res.grade).toBe('string');
    expect(Array.isArray(res.checks)).toBe(true);
    for (const c of res.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.pass).toBe('boolean');
      expect(typeof c.weight).toBe('number');
      expect(typeof c.hint).toBe('string');
    }
  });

  it('score equals the sum of passing weights, and grade follows the worker A/B/C/D/F boundaries', () => {
    for (const state of ['populated', 'empty'] as const) {
      const r = readinessFixture(state, q());
      const expected = r.checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
      expect(r.score).toBe(expected);
      const g =
        r.score >= 90 ? 'A' : r.score >= 80 ? 'B' : r.score >= 70 ? 'C' : r.score >= 60 ? 'D' : 'F';
      expect(r.grade).toBe(g);
    }
  });

  it('populated → grade C (3 of 4 pass → score 75, one actionable fix); empty → grade F (score 50)', () => {
    const pop = readinessFixture('populated', q());
    expect(pop.score).toBe(75);
    expect(pop.grade).toBe('C');
    expect(pop.checks.filter((c) => !c.pass).length).toBe(1); // the one "left to fix" the panel lists
    const empty = readinessFixture('empty', q());
    expect(empty.score).toBe(50);
    expect(empty.grade).toBe('F');
  });

  it('is registered under :param GET /sites/:id/readiness', () => {
    expect(registered('GET /sites/s-1/readiness')).toBe(true);
    expect(findFixture('GET /sites/s-1/readiness')).toBe(
      readinessFixture as unknown as ReturnType<typeof findFixture>,
    );
  });
});
