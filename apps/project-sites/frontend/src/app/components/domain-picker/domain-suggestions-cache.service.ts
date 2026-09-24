import { Injectable } from '@angular/core';

import type { DomainSuggestion } from '../../services/api.service';

const STORAGE_KEY = 'ps.domainSuggestions.v1';

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
 * Persisted to `localStorage` so the picks are ALWAYS cached — instant even
 * after a full page reload or a brand-new session, not just within one SPA
 * lifetime. localStorage access is wrapped in try/catch so private-mode / quota
 * / SSR never throw (per the app's localStorage discipline); an unavailable
 * store degrades to a pure in-memory `Map`.
 */
@Injectable({ providedIn: 'root' })
export class DomainSuggestionsCache {
  /** Last-known suggestion list per site id. */
  private readonly store = new Map<string, DomainSuggestion[]>();

  constructor() {
    this.hydrate();
  }

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
    if (siteId && list && list.length > 0) {
      this.store.set(siteId, list.slice());
      this.persist();
    }
  }

  /** Drop a site's cache (e.g. after the underlying site is deleted). */
  clear(siteId: string): void {
    if (this.store.delete(siteId)) this.persist();
  }

  /** Load the persisted cache from localStorage into the in-memory Map (fail-soft). */
  private hydrate(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, DomainSuggestion[]>;
      for (const [siteId, list] of Object.entries(parsed)) {
        if (Array.isArray(list) && list.length > 0) this.store.set(siteId, list);
      }
    } catch {
      /* private-mode / quota / bad JSON → stay in-memory only */
    }
  }

  /** Write the whole cache back to localStorage (fail-soft). */
  private persist(): void {
    try {
      const obj: Record<string, DomainSuggestion[]> = {};
      for (const [siteId, list] of this.store) obj[siteId] = list;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      /* quota / private-mode → keep the in-memory cache, skip persistence */
    }
  }
}
