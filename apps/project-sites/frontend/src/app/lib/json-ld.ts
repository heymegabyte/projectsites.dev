/**
 * @module lib/json-ld
 *
 * @description
 * Schema.org JSON-LD factories for public ProjectSites pages.
 *
 * Every public marketing surface gets:
 * - {@link organization}      — the publisher entity (single source of truth)
 * - {@link softwareApplication} — the product itself
 * - {@link webPage}            — the current page node
 * - {@link breadcrumbList}     — nested-route breadcrumb trail
 * - {@link faqPage}            — when real Q&A exists on the page (never fabricated)
 *
 * Per-tenant generated business sites get:
 * - {@link localBusiness} — NAP + geo + opening hours + price range
 *
 * @remarks
 * Every factory returns a plain object. Components inject it via the
 * {@link MetaService.setJsonLd} helper which serializes + injects a single
 * `<script type="application/ld+json">` tag per route, replacing any prior
 * tag on navigation.
 *
 * @example
 * ```ts
 * import { graph, organization, softwareApplication, webPage } from '../lib/json-ld';
 * import { MetaService } from '../services/meta.service';
 *
 * const meta = inject(MetaService);
 * meta.setJsonLd(graph([
 *   organization(),
 *   softwareApplication(),
 *   webPage({ url: 'https://projectsites.dev/press', title: 'Press kit' }),
 * ]));
 * ```
 */

export const BASE_URL = 'https://projectsites.dev';
export const ORG_ID = `${BASE_URL}/#org`;
export const APP_ID = `${BASE_URL}/#app`;

/** Top-level Organization node — every page that references the publisher links to this `@id`. */
export function organization() {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'ProjectSites by Megabyte Labs',
    alternateName: 'ProjectSites',
    url: `${BASE_URL}/`,
    logo: `${BASE_URL}/icon-512.png`,
    email: 'hey@megabyte.space',
    foundingDate: '2026-01-15',
    sameAs: [
      'https://github.com/heymegabyte',
      'https://x.com/MegabyteLabs',
      'https://www.linkedin.com/company/megabyte-labs',
    ],
  };
}

/** The product itself — used on home + press + features + pricing. */
export function softwareApplication() {
  return {
    '@type': 'SoftwareApplication',
    '@id': APP_ID,
    name: 'ProjectSites',
    description:
      'AI-native website builder for real businesses. Search your business, hand off a one-line brief, and watch a gorgeous magazine-grade website ship to your domain in under 15 minutes.',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: `${BASE_URL}/`,
    publisher: { '@id': ORG_ID },
    offers: [
      { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Base', price: '50', priceCurrency: 'USD' },
    ],
    // NOTE: no aggregateRating — it must reflect REAL, on-page reviews. There
    // are none yet, so a hardcoded "4.9/47" was a fabricated authority signal
    // (banned by thin-source-amplification + a Google structured-data policy
    // violation: ratings require corresponding visible review content). Add a
    // real AggregateRating only once genuine reviews exist + render on the page.
  };
}

/** WebPage node for the current route. */
export function webPage(args: { url: string; title: string; description?: string; image?: string }) {
  return {
    '@type': 'WebPage',
    '@id': `${args.url}#webpage`,
    url: args.url,
    name: args.title,
    description: args.description,
    isPartOf: { '@id': `${BASE_URL}/#website` },
    about: { '@id': ORG_ID },
    primaryImageOfPage: args.image,
  };
}

/** BreadcrumbList for nested routes (>1 segment). Skip on homepage. */
export function breadcrumbList(crumbs: ReadonlyArray<{ name: string; url: string }>) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

/**
 * FAQPage — ONLY when real Q&A exists on the page. Never fabricate Q&A just
 * to insert the schema; that's a build-fail per `[[always]]` JSON-LD rules.
 */
export function faqPage(qa: ReadonlyArray<{ q: string; a: string }>) {
  return {
    '@type': 'FAQPage',
    mainEntity: qa.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

/**
 * Person node — used on /about + /press for founder bio. `sameAs` array
 * preserves external identity profiles for EEAT signals.
 */
export function person(args: { id: string; name: string; jobTitle: string; sameAs?: readonly string[] }) {
  return {
    '@type': 'Person',
    '@id': args.id,
    name: args.name,
    jobTitle: args.jobTitle,
    worksFor: { '@id': ORG_ID },
    sameAs: args.sameAs,
  };
}

/**
 * Wrap a list of nodes into a Schema.org `@graph`. Always set `@context`
 * exactly once at the root so validators accept the document.
 */
export function graph(nodes: ReadonlyArray<Record<string, unknown>>) {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes,
  };
}
