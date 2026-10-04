import { defineFeatureManifest } from '@projectsites/feature-manifests';

/**
 * site_crawl — whole-site-crawl feature (CRAWL-0 domain + CRAWL-1 provider + CRAWL-2 routes).
 *
 * CRAWL-0 shipped the domain (Zod `schemas.ts` + the `CrawlProvider` port); CRAWL-1 wired the
 * `CloudflareCrawlProvider` to CF Browser Rendering's async, cursor-paginated `/crawl` REST API
 * (`provider.ts`); CRAWL-2 adds the HTTP surface (`handlers.ts`): SSRF-guarded `POST /api/crawl`
 * + status/pages/links/export.md/cancel, every route flag-gated (404 when off) with org-scoped
 * authz. Persistence (D1/R2) is CRAWL-3/4 — CRAWL-2 binds job→org in-process (TODO in handlers).
 * Flag `site_crawl` stays DARK (`enabled=0, rollout=0, stage='experimental'`) — the server guard
 * 404s every route until promotion, so the mounted routes are invisible in prod.
 */
export default defineFeatureManifest({
  slug: 'site_crawl',
  name: 'Whole-Site Crawl',
  description:
    'Whole-site crawling: Zod domain + CrawlProvider port + CF Browser-Run adapter (CRAWL-0/1), plus SSRF-guarded, flag-gated, org-scoped /api/crawl/* routes (CRAWL-2). DARK; persistence is CRAWL-3/4.',
  lifecycle: 'in-development',
  flagKey: 'site_crawl',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-04',
  updatedAt: '2026-10-04',
  routes: [],
  apiRoutes: [
    'POST /api/crawl',
    'GET /api/crawl/:id',
    'GET /api/crawl/:id/pages',
    'GET /api/crawl/:id/pages/:pageId',
    'GET /api/crawl/:id/links',
    'GET /api/crawl/:id/export.md',
    'DELETE /api/crawl/:id',
  ],
  permissions: [],
  dependencies: [],
  e2eTests: [],
  unitTests: [
    '../libs/features/site_crawl/__tests__/schemas.test.ts',
    '../libs/features/site_crawl/__tests__/provider.test.ts',
    '../libs/features/site_crawl/__tests__/handlers.test.ts',
  ],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: {},
    notes:
      'DARK (experimental). CRAWL-0 types + CRAWL-1 CF Browser-Run provider + CRAWL-2 /api/crawl/* routes (SSRF-guarded, flag-gated 404-when-off, org-scoped). Routes are mounted but the flag 404s them in prod. Persistence (D1/R2) is CRAWL-3/4; the jobId→orgId ownership binding is in-process until then.',
  },
  risks: [
    'SSRF: POST /api/crawl exposes a server-side fetch of a client URL. The route THROWS on a non-http(s)/credentialed/internal seed (fail-fast); per the redirect-follow memory, the fetch LAYER must re-validate every hop (redirect:manual) before promotion — landed with persistence (CRAWL-3/4).',
    'Ownership is in-process (jobId→orgId map) until CRAWL-3 persistence — a status/results poll after an isolate recycle 404s. Acceptable while DARK; MUST persist before promotion.',
    'The domain types are the contract CRAWL-1..4 build against; a CF-wire-shape leak into schemas.ts would be drift — keep provider specifics in provider.ts.',
  ],
  removalNotes:
    'No table, no durable state. Unmount `siteCrawl` in src/index.ts, delete the libs/features/site_crawl/ folder + the site_crawl flag-registry entry. Nothing to migrate.',
});
