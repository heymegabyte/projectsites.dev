import { defineFeatureManifest } from '@projectsites/feature-manifests';

/**
 * CRAWL-0 — provider-independent FOUNDATION of the whole-site-crawl feature.
 *
 * This slice ships ONLY the domain: Zod schemas (`schemas.ts`), the `CrawlProvider` port +
 * a Cloudflare STUB (`provider.ts`). No routes, workflow, or persistence (those are CRAWL-1..4).
 * Flag `site_crawl` is DARK (`enabled=0, rollout=0, stage='experimental'`) — the server guard
 * 404s every future route until promotion. Nothing user-reachable yet; this is the typed seam.
 */
export default defineFeatureManifest({
  slug: 'site_crawl',
  name: 'Whole-Site Crawl',
  description:
    'Provider-independent foundation (CRAWL-0) for whole-site crawling: Zod domain types + a CrawlProvider port + a Cloudflare Browser-Run stub. Dark, no routes.',
  lifecycle: 'in-development',
  flagKey: 'site_crawl',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-04',
  updatedAt: '2026-10-04',
  routes: [],
  apiRoutes: [],
  permissions: [],
  dependencies: [],
  e2eTests: [],
  unitTests: ['../libs/features/site_crawl/__tests__/schemas.test.ts'],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: false, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: {},
    notes:
      'DARK (experimental). CRAWL-0 is pure types + a provider stub — no reachable surface. The real Browser-Run /crawl wiring is CRAWL-1; routes/workflow/persistence CRAWL-1..4. Server guard 404s every future route until promoted.',
  },
  risks: [
    'Provider stub only: CloudflareCrawlProvider methods throw "CRAWL-1: not yet implemented" — this slice ships no working crawl, by design.',
    'The domain types are the contract CRAWL-1..4 build against; a later CF-shape leak into schemas.ts would be drift — keep provider specifics in provider.ts.',
  ],
  removalNotes:
    'No table, no route, no state. Delete the libs/features/site_crawl/ folder + the site_crawl flag-registry entry. Nothing to migrate.',
});
