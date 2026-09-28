import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { AdminEditorComponent } from './editor.component';
import { AdminStateService } from '../admin-state.service';
import { BoltEmbedService } from '../../../services/bolt-embed.service';
import { ApiService } from '../../../services/api.service';

/**
 * Deep-link contract for `/admin/editor/:siteId` (bug: sharing/opening an editor URL
 * 404'd because the `:siteId` route param was never consumed → the route fell through
 * to the admin not-found before the async site list resolved).
 *
 * The editor route shell must:
 *   1. read the `:siteId` param and select THAT site (via AdminStateService.selectSiteById)
 *   2. keep bare `/admin/editor` (no param) working — falls back to selectedSite() ?? sites[0]
 *   3. when the id is unknown/unowned AFTER sites load, show a coherent "site not found"
 *      state with a link to the sites grid — never a raw 404, never a doomed blank.
 */
describe('AdminEditorComponent deep-link (/admin/editor/:siteId)', () => {
  let fixture: ComponentFixture<AdminEditorComponent>;
  let host: HTMLElement;

  function build(opts: {
    siteId?: string | null;
    sites?: { id: string }[];
    selected?: { id: string } | null;
    loading?: boolean;
  }): { selectSiteById: jasmine.Spy } {
    const sites = signal<{ id: string }[]>(opts.sites ?? []);
    const selectedSiteId = signal<string | null>(opts.selected?.id ?? null);
    const loading = signal<boolean>(opts.loading ?? false);
    // Mirror the real computed: no-id → first; id → match ?? first; empty → null.
    const selectedSite = signal<{ id: string } | null>(opts.selected ?? sites()[0] ?? null);
    const selectSiteById = jasmine.createSpy('selectSiteById').and.callFake((id: string) => {
      const found = sites().find((s) => s.id === id) ?? null;
      selectedSiteId.set(id);
      selectedSite.set(found ?? sites()[0] ?? null);
      return !!found;
    });

    const paramMap = of(new Map<string, string>(opts.siteId ? [['siteId', opts.siteId]] : []));

    TestBed.configureTestingModule({
      imports: [AdminEditorComponent],
      providers: [
        {
          provide: AdminStateService,
          useValue: {
            selectedSite,
            selectedSiteId,
            sites,
            loading,
            selectSiteById,
            newSite: jasmine.createSpy('newSite'),
          },
        },
        {
          provide: BoltEmbedService,
          useValue: {
            editorReady: signal(false),
            loadingStage: signal('Booting the AI editor'),
            loadingPhase: signal(0),
          },
        },
        { provide: Router, useValue: { navigateByUrl: jasmine.createSpy('navigateByUrl') } },
        { provide: ApiService, useValue: {} },
        { provide: ActivatedRoute, useValue: { paramMap } },
      ],
    });
    fixture = TestBed.createComponent(AdminEditorComponent);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    return { selectSiteById };
  }

  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* */
    }
    TestBed.resetTestingModule();
  });

  it('reads the :siteId param and selects THAT site', () => {
    const { selectSiteById } = build({ siteId: 's2', sites: [{ id: 's1' }, { id: 's2' }] });
    expect(selectSiteById).toHaveBeenCalledWith('s2');
  });

  it('bare /admin/editor (no :siteId) does NOT force a selection', () => {
    const { selectSiteById } = build({ sites: [{ id: 's1' }], selected: { id: 's1' } });
    expect(selectSiteById).not.toHaveBeenCalled();
  });

  it('shows a coherent "site not found" state (link to sites grid) when the id is unknown after load', () => {
    build({ siteId: 'ghost', sites: [{ id: 's1' }], loading: false });
    const notFound = host.querySelector('[data-testid="editor-site-not-found"]');
    expect(notFound).withContext('a coherent not-found panel, not a raw 404').not.toBeNull();
    const link = host.querySelector('a[routerLink="/admin/sites"]');
    expect(link).withContext('a link back to the sites grid').not.toBeNull();
    // It must NOT masquerade as the empty "Welcome" state (shares the .empty-state-pretty
    // frame, so distinguish by COPY, not the shared style class).
    expect(host.textContent ?? '').toContain("We couldn't find that site");
    expect(host.textContent ?? '').not.toContain('Welcome to your admin');
  });

  it('does NOT show "site not found" while sites are still loading', () => {
    build({ siteId: 'maybe', sites: [], loading: true });
    expect(host.querySelector('[data-testid="editor-site-not-found"]'))
      .withContext('never flash not-found before the site list resolves')
      .toBeNull();
  });
});
