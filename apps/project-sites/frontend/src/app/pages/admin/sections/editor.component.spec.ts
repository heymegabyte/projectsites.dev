import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import { AdminEditorComponent } from './editor.component';
import { AdminStateService } from '../admin-state.service';
import { BoltEmbedService } from '../../../services/bolt-embed.service';
import { ApiService } from '../../../services/api.service';

/**
 * First coverage for the Editor route shell — the live `/admin/editor` host.
 * The bolt.diy iframe lives in AdminComponent; this thin component only owns
 * the 3-state machine + the Cmd+K dispatch:
 *   1. no site selected      → welcome empty state + onboarding checklist
 *   2. site + !editorReady    → cinematic "Booting your AI editor" veil
 *   3. site + editorReady     → neither (the persistent iframe shows through)
 * Plus openPalette() must dispatch a Meta+K keydown so the quick-find button
 * opens the command palette.
 */
describe('AdminEditorComponent (route shell state machine)', () => {
  let fixture: ComponentFixture<AdminEditorComponent>;
  let host: HTMLElement;
  let selectedSite: WritableSignal<{ id: string } | null>;
  let editorReady: WritableSignal<boolean>;
  let loadingPhase: WritableSignal<number>;

  function build(site: { id: string } | null, ready: boolean, phase = 0): void {
    selectedSite = signal<{ id: string } | null>(site);
    editorReady = signal<boolean>(ready);
    loadingPhase = signal<number>(phase);
    TestBed.configureTestingModule({
      imports: [AdminEditorComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite, newSite: jasmine.createSpy('newSite') } },
        { provide: BoltEmbedService, useValue: { editorReady, loadingStage: signal('Booting the AI editor'), loadingPhase } },
        { provide: Router, useValue: { navigateByUrl: jasmine.createSpy('navigateByUrl') } },
        { provide: ApiService, useValue: {} },
      ],
    });
    fixture = TestBed.createComponent(AdminEditorComponent);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  it('shows the welcome empty state (no veil) when no site is selected', () => {
    build(null, false);
    expect(host.querySelector('.empty-state-pretty')).withContext('welcome state').not.toBeNull();
    expect(host.textContent ?? '').toContain('Welcome to your admin');
    expect(host.querySelector('app-onboarding-checklist')).not.toBeNull();
    expect(host.querySelector('.ed-veil')).withContext('no booting veil without a site').toBeNull();
  });

  it('shows the cinematic booting veil (not the welcome) when a site is selected but the editor is not ready', () => {
    build({ id: 's1' }, false);
    expect(host.querySelector('.ed-veil')).withContext('booting veil').not.toBeNull();
    expect(host.textContent ?? '').toContain('Booting your AI editor');
    expect(host.querySelector('.empty-state-pretty')).withContext('welcome hidden once a site exists').toBeNull();
  });

  it('booting veil announces its status to assistive tech (WCAG 4.1.3 — role=status + aria-live)', () => {
    build({ id: 's1' }, false);
    // The orb spinner is aria-hidden, so without a live region a screen-reader
    // user gets total silence through the 30-60s WebContainer cold-boot AND
    // every loadingStage change. The veil must be a polite status region.
    const live = host.querySelector('[role="status"][aria-live="polite"]');
    expect(live).withContext('the boot veil must be a polite status live-region').not.toBeNull();
    expect(live!.textContent ?? '').toContain('Booting your AI editor');
  });

  it('shows neither veil nor welcome once the editor is ready (the persistent iframe shows through)', () => {
    build({ id: 's1' }, true);
    expect(host.querySelector('.ed-veil')).toBeNull();
    expect(host.querySelector('.empty-state-pretty')).toBeNull();
  });

  it('the segmented progress bar fills monotonically through loadingPhase (ONE indicator, never flickers)', () => {
    // The veil is a single continuous indicator: its 3 segments fill as the boot advances
    // (phase 2 → workspace + preparing done, preview still going). It never hides + re-shows.
    build({ id: 's1' }, false, 2);
    const steps = host.querySelectorAll('.ed-steps .ed-step');
    expect(steps.length).withContext('three boot-phase segments').toBe(3);
    expect(host.querySelectorAll('.ed-step.done').length).withContext('phase 2 → two filled').toBe(2);
    expect(steps[2].classList.contains('done')).withContext('preview segment not yet filled').toBeFalse();
    // The evolving stage label rides the same single veil.
    expect(host.querySelector('.ed-sub')?.textContent ?? '').toContain('Booting the AI editor');
  });

  it('openPalette() dispatches a Meta+K keydown so quick-find opens the command palette', () => {
    build(null, false);
    let captured: KeyboardEvent | null = null;
    const handler = (e: Event): void => { captured = e as KeyboardEvent; };
    document.addEventListener('keydown', handler);
    try {
      fixture.componentInstance.openPalette();
    } finally {
      document.removeEventListener('keydown', handler);
    }
    expect(captured).withContext('a keydown was dispatched').not.toBeNull();
    expect(captured!.key).toBe('k');
    expect(captured!.metaKey).toBeTrue();
  });
});
