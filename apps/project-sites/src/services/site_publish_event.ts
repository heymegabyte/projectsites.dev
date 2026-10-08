/**
 * @module services/site_publish_event
 *
 * @description
 * The canonical `site.published` golden-path event shape (§9, §16 event bus).
 * A publish transition (the embedded-bolt publish route, a future workflow
 * finalizer) builds the event through `buildSitePublishedEvent` and emits it via
 * `tryEmitEvent` — so the durable outbox drains the SAME shape to every consumer
 * (Hatchet orchestration + the async job plane). One builder keeps the emit shape
 * from drifting across callers.
 *
 * Idempotency is scoped to `(siteId, version)` via {@link sitePublishedScope}:
 * each version-publish emits exactly once, but a retry/replay of the SAME version
 * is a no-op INSERT — never a duplicate "customer published" event.
 *
 * @example
 * c.executionCtx.waitUntil(
 *   tryEmitEvent(
 *     c.env,
 *     buildSitePublishedEvent({ siteId, orgId, slug, version, url, userId, source: 'bolt-embedded', requestId }),
 *     { scope: sitePublishedScope(siteId, version) },
 *   ),
 * );
 *
 * @see services/event_bus.ts (EVENT_TYPES — `site.published`)
 * @see services/emit_event.ts (tryEmitEvent)
 */

import type { BuildEventInput } from './event_bus.js';

/** Where a publish originated (drives downstream attribution). */
export type SitePublishSource = 'bolt-embedded' | 'bolt' | 'workflow' | 'claim';

/** Inputs a publish transition has on hand when a site goes live. */
export interface SitePublishedInput {
  /** The site's UUID (D1 `sites.id`). */
  siteId: string;
  /** The owning org/tenant (`sites.org_id`). */
  orgId: string;
  /** The published slug (subdomain). */
  slug: string;
  /** The build version this publish wrote (`current_build_version`). */
  version: string;
  /** The live public URL of the site. */
  url: string;
  /** The acting user, when the publish was authenticated. */
  userId?: string | null;
  /** Origin of the publish. */
  source: SitePublishSource;
  /** Request correlation id (becomes the event `traceId`/`requestId`). */
  requestId?: string;
}

/**
 * Build the typed `site.published` event for the durable bus.
 *
 * @param input - The publish facts ({@link SitePublishedInput}).
 * @returns A {@link BuildEventInput} with `type:'site.published'`, producer
 *   `worker`, tenant = `orgId`, and `data:{ slug, version, url, source }`.
 * @example buildSitePublishedEvent({ siteId, orgId, slug, version, url, source:'bolt-embedded' })
 */
export function buildSitePublishedEvent(input: SitePublishedInput): BuildEventInput {
  return {
    type: 'site.published',
    producer: 'worker',
    tenantId: input.orgId,
    traceId: input.requestId ?? input.siteId,
    siteId: input.siteId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    data: {
      slug: input.slug,
      version: input.version,
      url: input.url,
      source: input.source,
    },
  };
}

/**
 * Idempotency scope for a `site.published` emit — one event per `(siteId,
 * version)`, so a re-publish of the same version dedupes but a new version emits.
 *
 * @param siteId - The site UUID.
 * @param version - The build version published.
 * @returns The scope tuple for `emitEvent`/`tryEmitEvent` `deps.scope`.
 * @example tryEmitEvent(env, ev, { scope: sitePublishedScope(siteId, version) })
 */
export function sitePublishedScope(siteId: string, version: string): readonly string[] {
  return [siteId, version];
}
