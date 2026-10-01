/**
 * Build Metrics — feature module manifest (fire-63).
 *
 * @remarks
 * The north-star "generation speed + cost" instrument: one `build_metrics` D1
 * row per site-generation workflow run (wall-ms + per-phase ms + estimated
 * USD), surfaced as a super-admin trend card. North star: <5min / ≤$1 per
 * build.
 *
 * This manifest formalizes the already-wired instrument (migration
 * `0652_build_metrics.sql` + `src/services/build_metrics.ts` +
 * `src/services/build_pricing.ts` + `src/routes/admin_build_metrics.ts` +
 * the Angular `generation-metrics-card.component.ts`) as a flagged feature
 * module per [[feature-module-architecture]]. The read endpoint is gated by
 * the `build_metrics` flag (DARK by default → 404 when off); recording is
 * always-on + fire-and-forget (a metrics failure never blocks a build).
 */
export const manifest = {
  slug: 'build_metrics',
  name: 'Build Metrics (speed + cost)',
  description:
    'Per-build generation speed + cost instrument. Records wall-ms, per-phase ms, and estimated USD per site build; surfaces p50/p95 as a super-admin trend card. North star: <5min / ≤$1 per build.',
  flagKey: 'build_metrics',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-10-01',
  apiPaths: ['/api/admin/build-metrics/summary'],
  uiPaths: [],
  migrations: ['0652_build_metrics.sql'],
  e2eTests: ['build-metrics.spec.ts'],
  unitTests: ['__tests__/admin_build_metrics_route.test.ts', 'services/__tests__/build_metrics.test.ts'],
};
