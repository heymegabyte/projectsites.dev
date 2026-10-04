import { defineFeatureManifest } from '@projectsites/feature-manifests';

/**
 * site_crawl — whole-site-crawl feature (CRAWL-0 foundation + CRAWL-1 provider wiring).
 *
 * CRAWL-0 shipped the domain: Zod schemas (`schemas.ts`) + the `CrawlProvider` port. CRAWL-1
 * wires the `CloudflareCrawlProvider` to CF Browser Rendering's async, cursor-paginated `/crawl`
 * REST API (`provider.ts`) — still NO routes, workflow, or persistence (those are CRAWL-2..4).
 * Flag `site_crawl` is DARK (`enabled=0, rollout=0, stage='experimental'`) — the server guard
 * 404s every future route until promotion. Nothing user-reachable yet; this is the typed engine.
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
  unitTests: [
    '../libs/features/site_crawl/__tests__/schemas.test.ts',
    '../libs/features/site_crawl/__tests__/provider.test.ts',
  ],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: false, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: {},
    notes:
      'DARK (experimental). CRAWL-0 types + CRAWL-1 CF Browser-Run /crawl provider — no reachable surface (no route mounts the provider). Routes/workflow/persistence are CRAWL-2..4. Server guard 404s every future route until promoted.',
  },
  risks: [
    'Pure provider code: CloudflareCrawlProvider is wired to CF /crawl but no route invokes it yet — this slice ships no user-reachable crawl, by design.',
    'SSRF/scope/persistence are NOT in this slice (CRAWL-2+). A route that exposes start() MUST add host-allowlist + ownership checks before promotion.',
    'The domain types are the contract CRAWL-1..4 build against; a CF-wire-shape leak into schemas.ts would be drift — keep provider specifics in provider.ts.',
  ],
  removalNotes:
    'No table, no route, no state. Delete the libs/features/site_crawl/ folder + the site_crawl flag-registry entry. Nothing to migrate.',
});
