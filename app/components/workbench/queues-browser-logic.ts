/**
 * @file Pure helper functions for the Queues Browser Data panel tab.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library. All functions are pure so they can be
 * tested with `node --experimental-strip-types` or Vitest without mocking. Sibling of the other
 * resource-browser logic modules (kv / r2 / vectorize).
 */
import type { QueueEndpoint } from '../../lib/embed/embedded-mode';

// ── formatDuration ──────────────────────────────────────────────────────────

/**
 * Format a seconds duration (queue retention / delivery-delay) as a short human string. `null`
 * (setting unavailable) → `"—"`, never a fabricated `0`.
 *
 * @param seconds - The duration in seconds, or `null`.
 * @returns e.g. `"—"`, `"0s"`, `"45s"`, `"5m"`, `"4h"`, `"4d"`.
 *
 * @example formatDuration(345600) // → "4d"
 * @example formatDuration(0)      // → "0s"
 * @example formatDuration(null)   // → "—"
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return '—';
  }

  const s = Math.trunc(seconds);
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h`;
  }
  return `${Math.floor(s / 86400)}d`;
}

// ── endpointLabel ─────────────────────────────────────────────────────────────

/**
 * Human label for a queue producer/consumer endpoint — the bound Worker script (+ environment when
 * present). Falls back to `"(unknown)"` when no script is reported.
 *
 * @param endpoint - The producer/consumer endpoint.
 * @returns e.g. `"my-worker"`, `"my-worker (staging)"`, `"(unknown)"`.
 *
 * @example endpointLabel({ script: 'ingest' })                     // → "ingest"
 * @example endpointLabel({ script: 'ingest', environment: 'prod' }) // → "ingest (prod)"
 * @example endpointLabel({})                                        // → "(unknown)"
 */
export function endpointLabel(endpoint: QueueEndpoint): string {
  const script = endpoint.script?.trim();
  if (!script) {
    return '(unknown)';
  }
  const env = endpoint.environment?.trim();
  return env ? `${script} (${env})` : script;
}
