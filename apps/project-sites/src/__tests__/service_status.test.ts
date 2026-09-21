/**
 * Tests for the Super-admin service-status roll-up core. Every case pins a widget-visible number or
 * the state machine that decides whether the banner says "all operational" vs "something is down".
 */
import {
  percentileMs,
  rollUpService,
  worstState,
  summarize,
  rollUpServices,
  type ServiceStatus,
} from '../services/service_status.js';

const NOW = 1_700_000_000_000;
/** A sample `min` minutes before NOW. */
const mk = (min: number, ok: boolean, latencyMs: number) => ({ at: NOW - min * 60_000, ok, latencyMs });

describe('percentileMs', () => {
  it('nearest-rank p50 / p95, rounded to whole ms', () => {
    expect(percentileMs([110, 120, 130, 140], 50)).toBe(120);
    expect(percentileMs([110, 120, 130, 140], 95)).toBe(140);
    expect(percentileMs([100, 100, 100, 5000], 95)).toBe(5000);
  });
  it('single value + empty', () => {
    expect(percentileMs([42], 95)).toBe(42);
    expect(percentileMs([], 50)).toBeNull();
  });
});

describe('rollUpService: state machine', () => {
  it('operational — all recent probes ok, fast', () => {
    const s = rollUpService(
      { key: 'd1', label: 'D1', samples: [mk(30, true, 120), mk(20, true, 140), mk(10, true, 110), mk(0, true, 130)] },
      { now: NOW },
    );
    expect(s.state).toBe('operational');
    expect(s.uptimePct).toBe(100);
    expect(s.p95LatencyMs).toBe(140);
    expect(s.reason).toBe('');
  });
  it('down — the MOST RECENT probe failed (records the incident time)', () => {
    const s = rollUpService(
      { key: 'stripe', label: 'Stripe', samples: [mk(20, true, 100), mk(10, true, 100), mk(0, false, 0)] },
      { now: NOW },
    );
    expect(s.state).toBe('down');
    expect(s.lastIncidentAt).toBe(NOW);
    expect(s.reason).toMatch(/most recent probe failed/);
  });
  it('degraded — uptime below the target even though the latest probe is ok', () => {
    const samples = [mk(90, false, 0), mk(80, true, 100), mk(70, true, 100), mk(60, true, 100), mk(50, true, 100), mk(40, true, 100), mk(30, true, 100), mk(20, true, 100), mk(10, true, 100), mk(0, true, 100)];
    const s = rollUpService({ key: 'ses', label: 'SES', samples }, { now: NOW });
    expect(s.uptimePct).toBe(90);
    expect(s.state).toBe('degraded');
    expect(s.reason).toMatch(/uptime/);
  });
  it('degraded — p95 latency over the target with 100% uptime', () => {
    const s = rollUpService(
      { key: 'ai', label: 'Workers AI', samples: [mk(30, true, 100), mk(20, true, 100), mk(10, true, 100), mk(0, true, 5000)] },
      { now: NOW },
    );
    expect(s.uptimePct).toBe(100);
    expect(s.state).toBe('degraded');
    expect(s.reason).toMatch(/p95 latency/);
  });
  it('unknown — no samples in the window (old data excluded)', () => {
    const s = rollUpService({ key: 'x', label: 'X', samples: [mk(48 * 60, true, 100)] }, { now: NOW });
    expect(s.state).toBe('unknown');
    expect(s.uptimePct).toBeNull();
    expect(s.sampleCount).toBe(0);
  });
  it('excludes future-dated samples (at > now)', () => {
    const s = rollUpService({ key: 'x', label: 'X', samples: [mk(-10, true, 100)] }, { now: NOW });
    expect(s.state).toBe('unknown');
  });
  it('caps the sparkline series to maxSeriesPoints (most recent kept, oldest→newest)', () => {
    const s = rollUpService(
      { key: 'x', label: 'X', samples: [mk(40, true, 1), mk(30, true, 2), mk(20, true, 3), mk(10, true, 4)] },
      { now: NOW, maxSeriesPoints: 2 },
    );
    expect(s.series).toHaveLength(2);
    expect(s.series[0].latencyMs).toBe(3);
    expect(s.series[1].latencyMs).toBe(4);
  });
});

describe('worstState', () => {
  it('down > degraded > unknown > operational; empty → operational', () => {
    expect(worstState(['operational', 'unknown'])).toBe('unknown');
    expect(worstState(['operational', 'degraded'])).toBe('degraded');
    expect(worstState(['degraded', 'down'])).toBe('down');
    expect(worstState([])).toBe('operational');
  });
});

describe('summarize + rollUpServices', () => {
  it('counts each state, picks the worst, averages only KNOWN uptimes', () => {
    const statuses = [
      { state: 'operational', uptimePct: 100 },
      { state: 'degraded', uptimePct: 98 },
      { state: 'down', uptimePct: 50 },
      { state: 'unknown', uptimePct: null },
    ] as ServiceStatus[];
    const sum = summarize(statuses);
    expect(sum).toMatchObject({ total: 4, operational: 1, degraded: 1, down: 1, unknown: 1, worst: 'down' });
    expect(sum.overallUptimePct).toBeCloseTo((100 + 98 + 50) / 3, 2);
  });
  it('an empty fleet is operational with null overall uptime', () => {
    const { services, summary } = rollUpServices([], { now: NOW });
    expect(services).toEqual([]);
    expect(summary.worst).toBe('operational');
    expect(summary.overallUptimePct).toBeNull();
  });
});
