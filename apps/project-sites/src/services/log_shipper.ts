/**
 * @module log_shipper
 * @description Log shipping configuration builder.
 *
 * Provides a pure builder function and typed constants for constructing
 * per-target log shipping configuration. Supports Axiom, Workers Tracing,
 * and Sentry as log targets.
 *
 * ## Usage
 *
 * ```ts
 * const config = buildShipConfig('axiom', 'https://axiom.example.com/api/v1/datasets/logs/ingest', 'xaat-abc123');
 * // → { target: 'axiom', endpoint: '...', apiKey: '...', batchSize: 100, flushIntervalMs: 5_000 }
 * ```
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported log shipping destinations. */
export type LogTarget = 'axiom' | 'workers-tracing' | 'sentry';

/** Resolved log shipper configuration. */
export interface LogShipConfig {
  /** Auth token or API key for the target. */
  apiKey: string;
  /** Maximum events per batch before flush. */
  batchSize: number;
  /** HTTP endpoint URL for the target ingestion API. */
  endpoint: string;
  /** Milliseconds to wait before flushing a partial batch. */
  flushIntervalMs: number;
  /** Target destination identifier. */
  target: LogTarget;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default batch sizes per log target.
 *
 * | Target             | Batch Size | Rationale                           |
 * |--------------------|------------|--------------------------------------|
 * | `axiom`            | 100        | Streams-friendly, up to 1 MB payload |
 * | `workers-tracing`  | 50         | OTLP span batch ceiling              |
 * | `sentry`           | 10         | Sentry envelope recommends small     |
 */
export const DEFAULT_BATCH_SIZE: Record<LogTarget, number> = Object.freeze({
  axiom: 100,
  sentry: 10,
  'workers-tracing': 50,
});

/**
 * Default flush intervals (milliseconds) per log target.
 *
 * | Target             | Interval | Rationale                                |
 * |--------------------|----------|------------------------------------------|
 * | `axiom`            | 5 000    | Sub-second latency at small scale         |
 * | `workers-tracing`  | 2 000    | Hot path; fire as fast as OTLP collector  |
 * | `sentry`           | 10 000   | Envelope timeout (Sentry recommends 15s)  |
 */
export const DEFAULT_FLUSH_INTERVAL_MS: Record<LogTarget, number> = Object.freeze({
  axiom: 5_000,
  sentry: 10_000,
  'workers-tracing': 2_000,
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a fully resolved {@link LogShipConfig} from minimal inputs.
 *
 * Applies target-appropriate defaults for `batchSize` and
 * `flushIntervalMs` so callers only need `target`, `endpoint`, and
 * `apiKey` to produce a production-ready config.
 *
 * @param target - Destination log shipper target.
 * @param endpoint - HTTP ingestion endpoint URL.
 * @param apiKey - Auth token / API key for the target.
 * @returns A fully resolved LogShipConfig.
 *
 * @example
 * ```ts
 * const config = buildShipConfig(
 *   'axiom',
 *   'https://api.axiom.co/v1/datasets/logs/ingest',
 *   'xaat-abc123',
 * );
 * // { target: 'axiom', ..., batchSize: 100, flushIntervalMs: 5_000 }
 * ```
 *
 * @example
 * ```ts
 * const config = buildShipConfig(
 *   'sentry',
 *   'https://o123.sentry.io/api/42/envelope/',
 *   'sntrys_abc',
 * );
 * // batchSize: 10, flushIntervalMs: 10_000
 * ```
 */
export function buildShipConfig(
  target: LogTarget,
  endpoint: string,
  apiKey: string,
): LogShipConfig {
  return {
    apiKey,
    batchSize: DEFAULT_BATCH_SIZE[target],
    endpoint,
    flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS[target],
    target,
  };
}
