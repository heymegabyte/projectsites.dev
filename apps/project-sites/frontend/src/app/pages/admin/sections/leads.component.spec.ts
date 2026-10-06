import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { AdminLeadsComponent, bestOutreachChannel } from './leads.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

/**
 * #9 lead-scanner admin console. Verifies the component's API wiring against the
 * worker surface (GET /api/admin/leads · POST .../scan · POST .../:id/claim-link)
 * with ApiService + ToastService mocked — no HTTP, no clipboard side effects.
 */
describe('AdminLeadsComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let toast: jasmine.SpyObj<ToastService>;

  const lead = {
    leadId: 'l1',
    businessName: 'Acme Roofing',
    hasWebsite: false,
    leadScore: 88,
    priority: true,
    email: null,
    emailStatus: null,
    source: 'google_places',
    createdAt: '2026-06-19T00:00:00Z',
    phone: null,
    website: null,
    socials: {},
    enrichedAt: null,
  };

  function make(): AdminLeadsComponent {
    return TestBed.runInInjectionContext(() => new AdminLeadsComponent());
  }

  beforeEach(() => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['get', 'post']);
    toast = jasmine.createSpyObj<ToastService>('ToastService', ['success', 'info', 'error']);
    api.get.and.returnValue(of({ leads: [lead], count: 1 }));
    api.post.and.returnValue(of({ summary: { scanned: 3, created: 2 } }));
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toast },
      ],
    });
  });

  it('loads leads on init (no-website filter on by default)', () => {
    const c = make();
    c.ngOnInit();
    expect(api.get).toHaveBeenCalledWith('/admin/leads?onlyNoWebsite=true');
    expect(c.leads().length).toBe(1);
    expect(c.loading()).toBe(false);
  });

  it('drops the filter param when no-website-only is off', () => {
    const c = make();
    c.onlyNoWebsite.set(false);
    c.loadLeads();
    expect(api.get).toHaveBeenCalledWith('/admin/leads');
  });

  it('a fresh loadLeads REPLACES the list + resets pagination (offset back to 0)', () => {
    const c = make();
    // Seed a prior second page so we can prove the next fresh load replaces (not appends).
    c.leads.set([lead, { ...lead, leadId: 'stale' }]);
    c.loadLeads();
    // No offset param on a fresh load → server starts from the top.
    expect(api.get).toHaveBeenCalledWith('/admin/leads?onlyNoWebsite=true');
    expect(c.leads().length).toBe(1); // replaced with the single mocked row, not 3
    expect(c.leads()[0]!.leadId).toBe('l1');
  });

  it('shows the load-more control only when total() exceeds the loaded count', () => {
    const c = make();
    // One row loaded, server says 60 total → more to fetch.
    api.get.and.returnValue(of({ leads: [lead], count: 1, total: 60 }));
    c.loadLeads();
    expect(c.canLoadMore()).toBe(true);
    // Server total equals the loaded count → nothing more to fetch.
    api.get.and.returnValue(of({ leads: [lead], count: 1, total: 1 }));
    c.loadLeads();
    expect(c.canLoadMore()).toBe(false);
  });

  it('loadMore requests offset = current length and APPENDS (list grows, not replaced)', () => {
    const c = make();
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...lead, leadId: `p1-${i}` }));
    const page2 = Array.from({ length: 10 }, (_, i) => ({ ...lead, leadId: `p2-${i}` }));
    api.get.and.returnValue(of({ leads: page1, count: 50, total: 60 }));
    c.loadLeads();
    expect(c.leads().length).toBe(50);
    expect(c.canLoadMore()).toBe(true);

    // Next page: must request offset=50 (current length) and keep the same filter.
    api.get.and.returnValue(of({ leads: page2, count: 10, total: 60 }));
    c.loadMore();
    expect(api.get).toHaveBeenCalledWith('/admin/leads?onlyNoWebsite=true&offset=50&limit=50');
    // APPENDED — the list grew to 60 (page1 ∪ page2), the first page is still present.
    expect(c.leads().length).toBe(60);
    expect(c.leads()[0]!.leadId).toBe('p1-0');
    expect(c.leads()[50]!.leadId).toBe('p2-0');
    expect(c.canLoadMore()).toBe(false); // 60 of 60 → control hides
    expect(c.loadingMore()).toBe(false);
  });

  it('loadMore appends with no filter param when no-website-only is off', () => {
    const c = make();
    c.onlyNoWebsite.set(false);
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...lead, leadId: `a${i}` }));
    api.get.and.returnValue(of({ leads: page1, count: 50, total: 90 }));
    c.loadLeads();
    api.get.and.returnValue(of({ leads: [lead], count: 1, total: 90 }));
    c.loadMore();
    expect(api.get).toHaveBeenCalledWith('/admin/leads?offset=50&limit=50');
  });

  it('loadMore no-ops when nothing more to fetch or a fetch is already in flight', () => {
    const c = make();
    api.get.and.returnValue(of({ leads: [lead], count: 1, total: 1 }));
    c.loadLeads();
    api.get.calls.reset();
    c.loadMore(); // canLoadMore() is false → must not fetch
    expect(api.get).not.toHaveBeenCalled();
  });

  it('clears the loadingMore guard on a load-more error (list preserved)', () => {
    const c = make();
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...lead, leadId: `x${i}` }));
    api.get.and.returnValue(of({ leads: page1, count: 50, total: 80 }));
    c.loadLeads();
    api.get.and.returnValue(throwError(() => new Error('boom')));
    c.loadMore();
    expect(c.loadingMore()).toBe(false);
    expect(c.leads().length).toBe(50); // first page still there, not wiped
  });

  it('sets loadError on a failed list fetch (never throws)', () => {
    api.get.and.returnValue(throwError(() => new Error('boom')));
    const c = make();
    c.loadLeads();
    expect(c.loadError()).toBe(true);
    expect(c.loading()).toBe(false);
  });

  it('scan posts the query + filter, records the summary, and reloads', () => {
    const c = make();
    c.query = 'roofers newark nj';
    c.scan();
    expect(api.post).toHaveBeenCalledWith('/admin/leads/scan', {
      query: 'roofers newark nj',
      onlyNoWebsite: true,
    });
    expect(c.lastScan()).toEqual({ scanned: 3, created: 2, degraded: null });
    expect(toast.success).toHaveBeenCalled();
    // reload fired (get called again after the post)
    expect(api.get).toHaveBeenCalled();
    expect(c.scanning()).toBe(false);
  });

  it('surfaces the degraded note + an error toast when a scan finds nothing (honest empty)', () => {
    api.post.and.returnValue(
      of({
        summary: { scanned: 0, created: 0 },
        source: 'osm',
        degraded: 'Could not geocode "Nowhereville ZZ" (free Nominatim lookup).',
      }),
    );
    const c = make();
    c.query = 'plumbers in Nowhereville ZZ';
    c.scan();
    expect(c.lastScan()?.degraded).toContain('geocode');
    expect(toast.error).toHaveBeenCalledWith(jasmine.stringContaining('geocode'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(c.scanning()).toBe(false);
  });

  it('does not scan a too-short or empty query', () => {
    const c = make();
    c.query = 'x';
    c.scan();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('copyClaimLink mints the link and writes it to the clipboard', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo();
    // jsdom/headless may not define clipboard — define a stub for the test.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    api.post.and.returnValue(
      of({ token: 'abc12345', claimUrl: 'https://projectsites.dev/api/claim/abc12345' }),
    );
    const c = make();
    c.copyClaimLink(lead);
    expect(api.post).toHaveBeenCalledWith('/admin/leads/l1/claim-link', {});
    expect(c.isCopying('l1')).toBe(false); // cleared synchronously on next
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('https://projectsites.dev/api/claim/abc12345');
  });

  it('clears the per-row busy guard on a mint error', () => {
    api.post.and.returnValue(throwError(() => new Error('nope')));
    const c = make();
    c.copyClaimLink(lead);
    expect(c.isCopying('l1')).toBe(false);
  });

  it('scanOsm posts the selected metro bbox + clamped maxLeads and records the summary', () => {
    api.post.and.returnValue(
      of({ summary: { discovered: 12, considered: 9, upserted: 7, skipped: 2, errors: 0 } }),
    );
    const c = make();
    c.metroIdx.set(0);
    c.osmMaxLeads = 9999; // over the 500 cap
    c.scanOsm();
    const [path, body] = api.post.calls.mostRecent().args;
    expect(path).toBe('/admin/leads/scan-osm');
    expect((body as { bbox: number[] }).bbox.length).toBe(4);
    expect((body as { maxLeads: number }).maxLeads).toBe(500); // clamped
    expect(c.osmSummary()?.upserted).toBe(7);
    expect(c.osmScanning()).toBe(false);
    expect(toast.success).toHaveBeenCalled();
  });

  it('scanOsm guards double-submit and clears the busy flag on error', () => {
    api.post.and.returnValue(throwError(() => new Error('boom')));
    const c = make();
    c.scanOsm();
    expect(c.osmScanning()).toBe(false);
    expect(api.post).toHaveBeenCalledWith('/admin/leads/scan-osm', jasmine.any(Object));
  });
});

// AL-036 (roadmap B pt.1): "Reach via" best-channel — reach a siteless business on
// the channel they actually use, derived only from real captured contact data.
describe('bestOutreachChannel', () => {
  it('prefers a DM-able social (Instagram first) over email/phone', () => {
    expect(
      bestOutreachChannel({ socials: { instagram: 'u', facebook: 'f' }, email: 'e@x.com', phone: '555' }),
    ).toEqual({ kind: 'social', network: 'instagram', label: 'Instagram DM' });
  });

  it('follows the network priority order (facebook before x)', () => {
    expect(bestOutreachChannel({ socials: { x: 'u', facebook: 'f' } })).toEqual({
      kind: 'social',
      network: 'facebook',
      label: 'Facebook DM',
    });
  });

  it('falls back to email when there is no DM-able social', () => {
    // Yelp/Google are listings, NOT DM channels → must not be chosen.
    expect(bestOutreachChannel({ socials: { yelp: 'y', google: 'g' }, email: 'owner@x.com' })).toEqual({
      kind: 'email',
      label: 'Email',
    });
  });

  it('falls back to phone when only a phone is captured', () => {
    expect(bestOutreachChannel({ phone: '+19735550100' })).toEqual({ kind: 'phone', label: 'Phone' });
  });

  it('returns null when no contact was captured (no false "reach via")', () => {
    expect(bestOutreachChannel({ socials: {}, email: null, phone: null })).toBeNull();
    expect(bestOutreachChannel({ socials: { yelp: 'y' }, email: '  ', phone: '' })).toBeNull();
  });
});
