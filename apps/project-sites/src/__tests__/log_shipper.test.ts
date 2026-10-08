/**
 * @module __tests__/log_shipper
 * @description Unit tests for the log shipping configuration builder.
 */

import {
  buildShipConfig,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
} from '../services/log_shipper.js';
import type { LogTarget, LogShipConfig } from '../services/log_shipper.js';

// ---------------------------------------------------------------------------
// DEFAULT_BATCH_SIZE
// ---------------------------------------------------------------------------

describe('DEFAULT_BATCH_SIZE', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_BATCH_SIZE)).toBe(true);
  });

  it('has axiom at 100', () => {
    expect(DEFAULT_BATCH_SIZE.axiom).toBe(100);
  });

  it('has workers-tracing at 50', () => {
    expect(DEFAULT_BATCH_SIZE['workers-tracing']).toBe(50);
  });

  it('has sentry at 10', () => {
    expect(DEFAULT_BATCH_SIZE.sentry).toBe(10);
  });

  it('covers every key in LogTarget', () => {
    const targets: LogTarget[] = ['axiom', 'workers-tracing', 'sentry'];
    for (const t of targets) {
      expect(typeof DEFAULT_BATCH_SIZE[t]).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_FLUSH_INTERVAL_MS
// ---------------------------------------------------------------------------

describe('DEFAULT_FLUSH_INTERVAL_MS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_FLUSH_INTERVAL_MS)).toBe(true);
  });

  it('has axiom at 5_000', () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS.axiom).toBe(5_000);
  });

  it('has workers-tracing at 2_000', () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS['workers-tracing']).toBe(2_000);
  });

  it('has sentry at 10_000', () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS.sentry).toBe(10_000);
  });

  it('covers every key in LogTarget', () => {
    const targets: LogTarget[] = ['axiom', 'workers-tracing', 'sentry'];
    for (const t of targets) {
      expect(typeof DEFAULT_FLUSH_INTERVAL_MS[t]).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// buildShipConfig
// ---------------------------------------------------------------------------

describe('buildShipConfig', () => {
  const endpoint = 'https://logs.example.com/ingest';
  const apiKey = 'test-key-abc';

  it('returns a fully resolved LogShipConfig', () => {
    const config = buildShipConfig('axiom', endpoint, apiKey);

    expect(config).toEqual<LogShipConfig>({
      target: 'axiom',
      endpoint,
      apiKey,
      batchSize: 100,
      flushIntervalMs: 5_000,
    });
  });

  it('applies axiom defaults', () => {
    const config = buildShipConfig('axiom', endpoint, apiKey);
    expect(config.batchSize).toBe(DEFAULT_BATCH_SIZE.axiom);
    expect(config.flushIntervalMs).toBe(DEFAULT_FLUSH_INTERVAL_MS.axiom);
  });

  it('applies workers-tracing defaults', () => {
    const config = buildShipConfig('workers-tracing', endpoint, apiKey);
    expect(config.batchSize).toBe(DEFAULT_BATCH_SIZE['workers-tracing']);
    expect(config.flushIntervalMs).toBe(DEFAULT_FLUSH_INTERVAL_MS['workers-tracing']);
  });

  it('applies sentry defaults', () => {
    const config = buildShipConfig('sentry', endpoint, apiKey);
    expect(config.batchSize).toBe(DEFAULT_BATCH_SIZE.sentry);
    expect(config.flushIntervalMs).toBe(DEFAULT_FLUSH_INTERVAL_MS.sentry);
  });

  it('preserves endpoint exactly', () => {
    const config = buildShipConfig('axiom', endpoint, apiKey);
    expect(config.endpoint).toBe(endpoint);
  });

  it('preserves apiKey exactly', () => {
    const config = buildShipConfig('axiom', endpoint, apiKey);
    expect(config.apiKey).toBe(apiKey);
  });

  it('accepts and preserves a custom endpoint string', () => {
    const customUrl = 'https://custom.axiom.co/ingest';
    const config = buildShipConfig('axiom', customUrl, apiKey);
    expect(config.endpoint).toBe(customUrl);
  });

  it('is a pure function (same inputs → same output)', () => {
    const a = buildShipConfig('sentry', endpoint, apiKey);
    const b = buildShipConfig('sentry', endpoint, apiKey);
    expect(a).toEqual(b);
    // Reference-inequality confirms fresh object each call
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Type-level coverage — all LogTarget values are exercisable
// ---------------------------------------------------------------------------

describe('LogTarget exhaustiveness', () => {
  it('every LogTarget produces a valid config', () => {
    const targets: LogTarget[] = ['axiom', 'workers-tracing', 'sentry'];

    for (const target of targets) {
      const config = buildShipConfig(target, 'https://example.com/ingest', 'key');
      expect(config.target).toBe(target);
      expect(config.batchSize).toBeGreaterThan(0);
      expect(config.flushIntervalMs).toBeGreaterThan(0);
      expect(typeof config.endpoint).toBe('string');
      expect(typeof config.apiKey).toBe('string');
    }
  });
});
