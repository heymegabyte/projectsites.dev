/**
 * @module services/fleet_benchmark_page
 * @description AN50 #2 — JSON-LD for the PUBLIC fleet-benchmark landing page
 * (`/benchmarks`) describing ProjectSites' own metrics-vs-fleet methodology.
 *
 * Accuracy-first (standing rule: JSON-LD types must be real — never pad):
 * `SoftwareApplication` is emitted with a `featureList` entry ONLY for a metric
 * that has BOTH a real fleet median AND a real cohort sample size — a metric
 * without published numbers is described in prose, never dressed up as schema.
 * Pure + zero-I/O + never throws.
 *
 * @packageDocumentation
 */

/** One published benchmark row (a real metric with a real fleet median). */
export interface BenchmarkPublishedMetric {
  /** Human metric label, e.g. `Contact form conversion`. */
  readonly label: string;
  /** Fleet median, e.g. `3.4`. */
  readonly median: number;
  /** Unit: `percent` renders as `3.4%`, `number` as `3.4`. */
  readonly unit: 'percent' | 'number';
  /** Cohort size behind the median; rows under the confidence floor are dropped. */
  readonly sampleSize: number;
}

/** A schema.org JSON-LD block. */
export type JsonLdBlock = Record<string, unknown>;

const DEFAULT_BASE = 'https://projectsites.dev';
const ROUTE = '/benchmarks';

/**
 * Minimum cohort size before a published median is trustworthy. Mirrors
 * `MIN_CONFIDENT_SAMPLE` in `services/fleet_benchmark.ts`.
 */
export const MIN_PUBLISHED_SAMPLE = 20;

/** Strip a trailing slash from a base URL (never throws). */
function normBase(base: string | undefined): string {
  return ((base ?? '').trim() || DEFAULT_BASE).replace(/\/+$/, '');
}

/** Render one metric as a `featureList` sentence, e.g. `Contact form conversion: 3.4%`. */
function describeMetric(metric: BenchmarkPublishedMetric): string {
  const value = metric.unit === 'percent' ? `${metric.median}%` : `${metric.median}`;
  return `${metric.label}: ${value}`;
}

/**
 * Build the JSON-LD block for the fleet-benchmark landing page.
 *
 * @param metrics - Published benchmark rows; low-confidence rows are dropped.
 * @param baseUrl - Site apex without a trailing slash; defaults to the prod apex.
 * @returns A single `SoftwareApplication` block with a `featureList` naming only
 *   the metrics that carry real published numbers.
 *
 * @example
 * buildFleetBenchmarkJsonLd([{ label: 'Form conversion', median: 3.4, unit: 'percent', sampleSize: 50 }])
 *   .featureList[0]  // → 'Form conversion: 3.4%'
 */
export function buildFleetBenchmarkJsonLd(
  metrics: readonly BenchmarkPublishedMetric[],
  baseUrl?: string,
): JsonLdBlock & { featureList: string[] } {
  const base = normBase(baseUrl);
  const published = (metrics ?? []).filter(
    (m) =>
      m &&
      Number.isFinite(m.median) &&
      Number.isFinite(m.sampleSize) &&
      m.sampleSize >= MIN_PUBLISHED_SAMPLE &&
      typeof m.label === 'string' &&
      m.label.trim().length > 0,
  );
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ProjectSites Fleet Benchmarks',
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Website Analytics',
    operatingSystem: 'Web',
    url: `${base}${ROUTE}`,
    description:
      'Compare your website conversion and engagement metrics against the anonymized ProjectSites fleet median for your industry — see your quartile, not just a number.',
    featureList: published.map(describeMetric),
  };
}
