import { Injectable } from '@angular/core';

import type { DomainSuggestion } from '../../services/api.service';

/**
 * Stale-while-revalidate cache for the domain-picker's AI suggestions, keyed by
 * site id.
 *
 * A `providedIn: 'root'` singleton so the last-known suggestion set survives the
 * picker component being torn down + re-created on admin route navigation — per
 * the frontend "Stale-while-revalidate for list pages" performance doctrine. The
 * picker paints the cached list INSTANTLY on re-open (no skeleton flash), then
 * revalidates in the background and writes the fresh list back here. Trigger
 * hover/focus pre-warms the cache so even the FIRST open is instant.
 *
 * In-memory only (a `Map`) — suggestions are cheap to re-fetch and never
 * security-sensitive, so there's no need to persist across a full page reload.
 */
@Injectable({ providedIn: 'root' })
export class DomainSuggestionsCache {
  /** Last-known suggestion list per site id. */
  private readonly store = new Map<string, DomainSuggestion[]>();

  /** True when a non-empty list has been cached for this site. */
  has(siteId: string): boolean {
    const list = this.store.get(siteId);
    return !!list && list.length > 0;
  }

  /** The cached list for a site, or `null` when nothing (usable) is cached yet. */
  get(siteId: string): DomainSuggestion[] | null {
    const list = this.store.get(siteId);
    return list && list.length > 0 ? list.slice() : null;
  }

  /**
   * Replace the cached list for a site. Empty/nullish lists are IGNORED so a
   * transient empty response never clobbers a good cached set (SWR must never
   * downgrade a populated view to empty on a flaky revalidate).
   */
  set(siteId: string, list: DomainSuggestion[] | null | undefined): void {
    if (siteId && list && list.length > 0) this.store.set(siteId, list.slice());
  }

  /** Drop a site's cache (e.g. after the underlying site is deleted). */
  clear(siteId: string): void {
    this.store.delete(siteId);
  }
}
