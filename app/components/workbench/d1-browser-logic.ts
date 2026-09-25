/**
 * @file Pure helper functions for the D1 Overview Data panel tab.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library. All functions are pure so they can be
 * tested with Vitest without mocking. Sibling of the other resource-browser logic modules
 * (kv / r2 / vectorize / queues).
 */
import type { D1DatabaseSummary, D1ExportData, D1ResponseMessage } from '../../lib/embed/embedded-mode';

// ── formatBytes ───────────────────────────────────────────────────────────────

/**
 * Format a byte count (D1 `file_size`) as a short human string. `null` (metric unavailable) →
 * `"—"`, never a fabricated `0`. Uses binary units (KiB/MiB/GiB) to match Cloudflare's D1 sizing.
 *
 * @param bytes - The size in bytes, or `null` when the CF API omitted it.
 * @returns e.g. `"—"`, `"0 B"`, `"512 B"`, `"1.5 KB"`, `"31.5 MB"`, `"2.1 GB"`.
 *
 * @example formatBytes(33067008) // → "31.5 MB"
 * @example formatBytes(0)        // → "0 B"
 * @example formatBytes(null)     // → "—"
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.trunc(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal, but drop a trailing ".0" for whole values.
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

// ── formatCount ───────────────────────────────────────────────────────────────

/**
 * Format an integer metric (D1 `num_tables`) with thousands separators. `null` → `"—"`, never a
 * fabricated `0` (a real `0` is shown as `"0"`).
 *
 * @param n - The count, or `null` when unavailable.
 * @returns e.g. `"—"`, `"0"`, `"42"`, `"1,024"`.
 *
 * @example formatCount(1024) // → "1,024"
 * @example formatCount(0)    // → "0"
 * @example formatCount(null) // → "—"
 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return '—';
  }
  return Math.trunc(n).toLocaleString('en-US');
}

// ── dbLabel ───────────────────────────────────────────────────────────────────

/**
 * Human label for a database row — its name, falling back to the id when unnamed.
 *
 * @param db - The database summary.
 * @returns The trimmed name, or the id when the name is blank.
 *
 * @example dbLabel({ id: 'ea3e…', name: 'prod-db' }) // → "prod-db"
 * @example dbLabel({ id: 'ea3e…', name: '' })        // → "ea3e…"
 */
export function dbLabel(db: D1DatabaseSummary): string {
  const name = db.name?.trim();
  return name ? name : db.id;
}

// ── classifyExportResponse ────────────────────────────────────────────────────

/** The next action for the export poll loop, derived purely from a bridge response. */
export type ExportAction =
  | { kind: 'done'; data: D1ExportData }
  | { kind: 'processing'; bookmark?: string }
  | { kind: 'error'; message: string };

/**
 * Classify an export `PS_D1_RESPONSE` into the next UI action — the pure core of the poll loop
 * (the component just acts on the result). NEVER treats a `complete` without a `signedUrl`, or an
 * `error`/`unavailable` status, as success — so a fabricated/absent URL can't leak into a download.
 *
 * @param res - a bridge response (`{ ok, data?, error? }`).
 * @returns `done` (URL present), `processing` (resume with `bookmark`), or `error` (human message).
 *
 * @example classifyExportResponse({ ok: true, data: { status: 'complete', signedUrl: 'u', note: '' } })
 *   // → { kind: 'done', data: {…} }
 * @example classifyExportResponse({ ok: true, data: { status: 'processing', bookmark: 'b', note: '' } })
 *   // → { kind: 'processing', bookmark: 'b' }
 * @example classifyExportResponse({ ok: false, error: 'timed out' }) // → { kind: 'error', message: 'timed out' }
 */
export function classifyExportResponse(res: Pick<D1ResponseMessage, 'ok' | 'data' | 'error'>): ExportAction {
  if (!res.ok || !res.data || typeof res.data !== 'object' || !('status' in res.data)) {
    return { kind: 'error', message: res.error ?? 'Export failed' };
  }
  const data = res.data as D1ExportData;
  if (data.status === 'complete' && data.signedUrl) return { kind: 'done', data };
  if (data.status === 'processing') return { kind: 'processing', bookmark: data.bookmark };
  return {
    kind: 'error',
    message: data.reason ?? (data.status === 'unavailable' ? 'D1 not available' : 'Export failed'),
  };
}
