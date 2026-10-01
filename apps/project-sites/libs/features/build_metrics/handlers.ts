/**
 * Build Metrics feature module — handler re-export.
 *
 * @remarks
 * The implementation lives at `src/routes/admin_build_metrics.ts` (mounted in
 * `src/index.ts`) and `src/services/build_metrics.ts` — this module formalizes
 * that already-wired instrument as a flagged feature per
 * [[feature-module-architecture]] WITHOUT duplicating logic (per
 * [[interconnectedness]] — recycle proven code, never ship a thinner
 * reimplementation). Importers that want the Hono sub-app reach for the
 * canonical route; this re-export keeps the module self-describing.
 */
export { adminBuildMetrics } from '../../../src/routes/admin_build_metrics.js';
