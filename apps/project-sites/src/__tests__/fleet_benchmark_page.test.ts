/**
 * Fleet-benchmark landing-page JSON-LD — schema-accuracy-first.
 *
 * Standing rule: JSON-LD types must be real; NEVER pad. A metric only reaches
 * `featureList` when it carries a real median AND a confident cohort sample.
 */
import {
  buildFleetBenchmarkJsonLd,
  MIN_PUBLISHED_SAMPLE,
  type BenchmarkPublishedMetric,
} from '../services/fleet_benchmark_page.js';
import { isKnownMarketingRoute, resolveMarketingMeta } from '../marketing_routes.js';

const confident = (over: Partial<BenchmarkPublishedMetric> = {}): BenchmarkPublishedMetric => ({
  label: 'Contact form conversion',
  median: 3.4,
  unit: 'percent',
  sampleSize: 50,
  ...over,
});

describe('buildFleetBenchmarkJsonLd', () => {
  it('emits a schema-valid SoftwareApplication block for the /benchmarks route', () => {
    const ld = buildFleetBenchmarkJsonLd([confident()]);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('SoftwareApplication');
    expect(ld.url).toBe('https://projectsites.dev/benchmarks');
    expect(typeof ld.name).toBe('string');
    expect((ld.description as string).length).toBeGreaterThan(50);
  });

  it('honours a custom base URL without doubling the slash', () => {
    const ld = buildFleetBenchmarkJsonLd([confident()], 'https://staging.example.com/');
    expect(ld.url).toBe('https://staging.example.com/benchmarks');
  });

  it('formats percent and plain-number medians distinctly', () => {
    const ld = buildFleetBenchmarkJsonLd([
      confident({ unit: 'percent', median: 3.4 }),
      confident({ label: 'Avg. session pages', unit: 'number', median: 2.7 }),
    ]);
    expect(ld.featureList).toEqual(['Contact form conversion: 3.4%', 'Avg. session pages: 2.7']);
  });

  it('DROPS a metric whose cohort is below the confidence floor (never pads)', () => {
    const ld = buildFleetBenchmarkJsonLd([
      confident(),
      confident({ label: 'Bounce rate', sampleSize: MIN_PUBLISHED_SAMPLE - 1 }),
    ]);
    expect(ld.featureList).toEqual(['Contact form conversion: 3.4%']);
  });

  it('DROPS metrics with a non-finite median or an empty label', () => {
    const ld = buildFleetBenchmarkJsonLd([
      confident({ median: Number.NaN }),
      confident({ label: '   ' }),
      confident({ median: Number.POSITIVE_INFINITY }),
    ]);
    expect(ld.featureList).toEqual([]);
  });

  it('is still schema-valid with zero published metrics (no fabricated rows)', () => {
    const ld = buildFleetBenchmarkJsonLd([]);
    expect(ld['@type']).toBe('SoftwareApplication');
    expect(ld.featureList).toEqual([]);
  });

  it('never throws on null/undefined input', () => {
    expect(() =>
      buildFleetBenchmarkJsonLd(undefined as unknown as readonly BenchmarkPublishedMetric[]),
    ).not.toThrow();
  });
});

describe('/benchmarks marketing route wiring (both registries)', () => {
  it('is a known marketing route (worker known-route set) — else it soft-404s', () => {
    expect(isKnownMarketingRoute('/benchmarks')).toBe(true);
  });

  it('is reachable at the exact JSON-LD url the page advertises', () => {
    expect(isKnownMarketingRoute(new URL(buildFleetBenchmarkJsonLd([]).url).pathname)).toBe(true);
  });

  it('carries dedicated crawler meta within the SEO char gates', () => {
    const meta = resolveMarketingMeta('/benchmarks');
    expect(meta).not.toBeNull();
    expect(meta!.title.length).toBeGreaterThanOrEqual(30);
    expect(meta!.title.length).toBeLessThanOrEqual(60);
    expect(meta!.description.length).toBeGreaterThanOrEqual(120);
    expect(meta!.description.length).toBeLessThanOrEqual(156);
  });

  it('is not reachable under a near-miss prefix (no substring shadowing)', () => {
    expect(isKnownMarketingRoute('/benchmark-typo')).toBe(false);
  });
});
