import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { VoiceComponent } from './voice.component';
import { AdminStateService } from '../admin-state.service';

/**
 * Guards the Voice section cyan/black cohesion + a11y convergence pass:
 *  - the surface-count stat renders through `<app-rolling-counter>` (brand mandate)
 *  - the shell keeps ≥3 `psReveal` entrance hosts
 *  - tablist / tabpanel / no-site-status ARIA contract holds
 *  - the "Live for X" pill is the cyan/black branded variant (no off-brand green)
 */
describe('VoiceComponent (cyan/black cohesion + a11y)', () => {
  let fixture: ComponentFixture<VoiceComponent>;
  let selectedSite: WritableSignal<{ id: string; business_name: string } | null>;
  let navigate: jasmine.Spy;

  function build(initial: { id: string; business_name: string } | null, tabParam: string | null = null): void {
    selectedSite = signal(initial);
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    TestBed.configureTestingModule({
      imports: [VoiceComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite } },
        { provide: Router, useValue: { navigate } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: (k: string) => (k === 'tab' ? tabParam : null) } } },
        },
      ],
    });
    fixture = TestBed.createComponent(VoiceComponent);
    fixture.detectChanges();
  }

  // Keep the localStorage-remembered tab from leaking across tests.
  beforeEach(() => { try { localStorage.removeItem('voice.activeTab'); } catch { /* */ } });
  afterEach(() => TestBed.resetTestingModule());

  it('renders the surface count through <app-rolling-counter> (numeric stat mandate)', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const el: HTMLElement = fixture.nativeElement;
    const strip = el.querySelector('[data-testid="voice-stat-strip"]');
    expect(strip).toBeTruthy();
    // The numeric stat is NOT a raw text node — it is an <app-rolling-counter>.
    expect(strip!.querySelector('app-rolling-counter')).toBeTruthy();
    expect(el.querySelector('.stat-strip-num app-rolling-counter')).toBeTruthy();
  });

  it('keeps at least 3 psReveal entrance hosts', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const el: HTMLElement = fixture.nativeElement;
    // psReveal is the attribute selector RevealOnScrollDirective binds to.
    const revealHosts = el.querySelectorAll('[psReveal]');
    expect(revealHosts.length).toBeGreaterThanOrEqual(3);
  });

  it('exposes the WAI-ARIA tablist contract when a site is selected', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const el: HTMLElement = fixture.nativeElement;
    const tablist = el.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    expect(tablist!.getAttribute('aria-label')).toBe('Voice sections');
    const tabs = el.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(7);
    // Exactly one tab is selected + tabindex=0 (roving tabindex pattern).
    const selected = Array.from(tabs).filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute('tabindex')).toBe('0');
    expect(el.querySelector('[role="tabpanel"]')).toBeTruthy();
  });

  it('renders the cyan/black branded live pill (no off-brand green class)', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const el: HTMLElement = fixture.nativeElement;
    const pill = el.querySelector('[data-testid="voice-live-pill"]');
    expect(pill).toBeTruthy();
    expect(pill!.textContent).toContain('Vito Salon');
    // The branded pill uses the .header-pill class (themed by --ps-accent tokens).
    expect(pill!.classList.contains('header-pill')).toBe(true);
  });

  it('shows an ARIA status (role=status) guard when no site is selected', () => {
    build(null);
    const el: HTMLElement = fixture.nativeElement;
    const status = el.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain('No site selected');
    // No tablist / live pill when there is no site.
    expect(el.querySelector('[role="tablist"]')).toBeNull();
    expect(el.querySelector('[data-testid="voice-live-pill"]')).toBeNull();
  });

  // Cockpit cohesion: the no-site guard should use the shared cyan
  // <app-empty-state> (matching domains/site-branches), not a bespoke
  // off-brand amber notice box.
  it('renders the no-site guard via the shared cyan app-empty-state (cyan SVG glyph, no amber notice)', () => {
    build(null);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-empty-state')).withContext('uses the cockpit cyan empty-state primitive').toBeTruthy();
    expect(el.querySelector('.notice-amber')).withContext('no off-brand amber notice box').toBeNull();
    expect(el.querySelector('app-empty-state svg')).withContext('icon maps to a monochrome cyan SVG').toBeTruthy();
  });

  it('opens the tab named by ?tab= on load (bookmarkable), winning over the stored tab', () => {
    try { localStorage.setItem('voice.activeTab', 'conversations'); } catch { /* */ }
    build({ id: 's1', business_name: 'Vito Salon' }, 'agent');
    expect(fixture.componentInstance.activeTab()).withContext('deep-link wins over localStorage').toBe('agent');
  });

  it('ignores an unknown ?tab= value and keeps the default tab', () => {
    build({ id: 's1', business_name: 'Vito Salon' }, 'bogus');
    expect(fixture.componentInstance.activeTab()).toBe('numbers');
  });

  it('setTab() reflects the choice in the URL (merge + replaceUrl, SPA no-reload)', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    navigate.calls.reset();
    fixture.componentInstance.setTab('mcps');
    expect(fixture.componentInstance.activeTab()).toBe('mcps');
    expect(navigate).toHaveBeenCalledWith(
      [],
      jasmine.objectContaining({
        queryParams: { tab: 'mcps' },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
  });

  it('arrow-key navigation moves the active tab (WCAG 2.2 tab pattern)', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const cmp = fixture.componentInstance;
    expect(cmp.activeTab()).toBe('numbers');
    cmp.onTabKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(cmp.activeTab()).toBe('conversations');
    cmp.onTabKey(new KeyboardEvent('keydown', { key: 'End' }));
    expect(cmp.activeTab()).toBe('share');
    cmp.onTabKey(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(cmp.activeTab()).toBe('numbers');
  });

  // A modified arrow (Alt+Left / Cmd+Left browser-back, Cmd+Right forward,
  // Ctrl+arrow OS shortcuts) must pass through untouched — the tablist must
  // NOT hijack the keystroke (no preventDefault, no tab switch). Without the
  // guard, a keyboard user's native browser/OS navigation gesture is swallowed
  // while focus rests in the voice tab row.
  it('ignores modified arrow keys so native browser/OS shortcuts pass through', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const cmp = fixture.componentInstance;
    expect(cmp.activeTab()).toBe('numbers');

    for (const mod of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }] as const) {
      const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', ...mod });
      const prevent = spyOn(ev, 'preventDefault');
      cmp.onTabKey(ev);
      expect(cmp.activeTab()).withContext(`modified arrow (${JSON.stringify(mod)}) must not switch tabs`).toBe('numbers');
      expect(prevent).withContext('native shortcut must not be blocked').not.toHaveBeenCalled();
    }
  });

  // Re-selecting the already-active tab is a no-op: setTab must early-return so
  // it does NOT fire a redundant router.navigate() (and redundant localStorage
  // write). Without the guard, pressing Home while already on the first tab, or
  // holding an arrow key at a wrap boundary, or clicking the active tab, spams
  // a replaceUrl navigation per keystroke for zero state change. This is the
  // same "re-entry is a no-op" discipline as the mutation double-submit guard,
  // applied to redundant navigation.
  it('setTab() is a no-op when the tab is already active (no redundant router.navigate)', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const cmp = fixture.componentInstance;
    expect(cmp.activeTab()).toBe('numbers');
    navigate.calls.reset();

    // Re-select the current tab → must NOT navigate again.
    cmp.setTab('numbers');
    expect(cmp.activeTab()).toBe('numbers');
    expect(navigate).withContext('re-selecting the active tab must not re-navigate').not.toHaveBeenCalled();

    // A genuine change still navigates exactly once.
    cmp.setTab('agent');
    expect(cmp.activeTab()).toBe('agent');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('onTabKey Home on the first tab does not fire a redundant navigation', () => {
    build({ id: 's1', business_name: 'Vito Salon' });
    const cmp = fixture.componentInstance;
    expect(cmp.activeTab()).toBe('numbers');
    navigate.calls.reset();
    // Already on the first tab → Home is a no-op move → no navigation.
    cmp.onTabKey(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(cmp.activeTab()).toBe('numbers');
    expect(navigate).withContext('Home on the first tab must not re-navigate').not.toHaveBeenCalled();
  });
});
