import {
  mcpConnectionsFixture,
  snapshotMetricsFixture,
  type McpConnectionsResponse,
  type SnapshotMetricsResponse,
} from './per-site.fixture';
import { toRegistryKey } from './index';

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
