/**
 * @file Pure helper functions for the Vectorize Browser Data panel tab.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library. All functions are pure so they can be
 * tested with `node --experimental-strip-types` or Vitest without mocking. Sibling of
 * {@link ./kv-browser-logic} + {@link ./r2-browser-logic}.
 */

// ── formatMetric ──────────────────────────────────────────────────────────────

/**
 * Human-label a Vectorize distance metric. Unknown/empty → the raw value or `"—"`.
 *
 * @param metric - The index metric (`"cosine"`, `"euclidean"`, `"dot-product"`), or `null`.
 * @returns e.g. `"Cosine"`, `"Euclidean"`, `"Dot product"`, `"—"`.
 *
 * @example formatMetric('cosine')      // → "Cosine"
 * @example formatMetric('dot-product') // → "Dot product"
 * @example formatMetric(null)          // → "—"
 */
export function formatMetric(metric: string | null): string {
  if (metric === null || metric.trim() === '') {
    return '—';
  }

  switch (metric.toLowerCase()) {
    case 'cosine':
      return 'Cosine';
    case 'euclidean':
      return 'Euclidean';
    case 'dot-product':
    case 'dot_product':
      return 'Dot product';
    default:
      return metric;
  }
}

// ── formatVectorCount ─────────────────────────────────────────────────────────

/**
 * Thousands-separated vector count. `null` (count unavailable from the API) → `"—"`, never a
 * fabricated `0` — an honest "unknown" is not the same as "empty".
 *
 * @param count - The vector count, or `null` when the /info endpoint didn't supply it.
 * @returns e.g. `"—"`, `"0"`, `"1,024"`, `"2,500,000"`.
 *
 * @example formatVectorCount(null)     // → "—"
 * @example formatVectorCount(1024)     // → "1,024"
 */
export function formatVectorCount(count: number | null): string {
  if (count === null || !Number.isFinite(count)) {
    return '—';
  }

  return Math.trunc(count).toLocaleString('en-US');
}

// ── formatDimensions ──────────────────────────────────────────────────────────

/**
 * Format an index's dimensionality. `null` → `"—"`.
 *
 * @param dimensions - The vector dimensions, or `null`.
 * @returns e.g. `"768-dim"`, `"—"`.
 *
 * @example formatDimensions(768) // → "768-dim"
 * @example formatDimensions(null) // → "—"
 */
export function formatDimensions(dimensions: number | null): string {
  if (dimensions === null || !Number.isFinite(dimensions)) {
    return '—';
  }

  return `${Math.trunc(dimensions)}-dim`;
}
