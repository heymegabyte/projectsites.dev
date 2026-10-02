import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { FeatureDossierComponent } from './feature-dossier.component';
import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import type { DossierModel } from './dossier.model';

/**
 * §17 ticket: the `/admin/site-features` "Spec ↗" full-screen modal must behave
 * like a proper takeover dialog — Esc closes, focus is trapped, it carries the
 * dialog role/aria, AND it locks background page scroll while open (a
 * `position:fixed inset:0` takeover otherwise lets the page behind scroll, so a
 * trackpad swipe at the dossier's scroll boundary bleeds to the admin page
 * underneath). This spec locks all four; the scroll-lock assertion is the RED
 * driver (the dossier never touched `document.body.style.overflow`).
 */
const MODEL: DossierModel = {
  kind: 'Feature',
  key: 'ai_concierge_widget',
  name: 'AI Concierge Widget',
  summary: 'A site-embedded concierge that answers visitor questions.',
  checklist: ['Answers FAQs', 'Escalates to email'],
  e2eTests: ['e2e/ai_concierge_widget/widget.spec.ts'],
  stage: 'beta',
  rolloutPercent: 25,
  requiredPlan: 'pro',
};

describe('FeatureDossierComponent (§17 spec-sheet takeover modal)', () => {
  let fixture: ComponentFixture<FeatureDossierComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FeatureDossierComponent],
      providers: [
        provideNoopAnimations(),
        { provide: ApiService, useValue: { post: () => ({ subscribe() {} }), get: () => ({ subscribe() {} }) } },
        { provide: ToastService, useValue: { success() {}, error() {} } },
      ],
    });
    fixture = TestBed.createComponent(FeatureDossierComponent);
  });

  afterEach(() => {
    // Guard the global side effects can't leak between specs: the scroll-lock
    // overflow AND any overlay we re-parented to <body> that survived.
    document.body.style.overflow = '';
    document.body.querySelectorAll('[data-testid="feature-dossier"]').forEach((n) => n.remove());
    TestBed.resetTestingModule();
  });

  function open(): HTMLElement {
    fixture.componentRef.setInput('model', MODEL);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** The `.fd-root` is re-parented to <body> on open (stacking-context fix), so
   *  it's no longer under the component host — resolve it from the document. */
  function dossierRoot(): HTMLElement | null {
    return document.querySelector('[data-testid="feature-dossier"]');
  }

  it('renders nothing when closed and locks no scroll', () => {
    fixture.componentRef.setInput('model', MODEL);
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="feature-dossier"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('is a focus-trapped dialog with the right aria when open', () => {
    open();
    const root = dossierRoot();
    expect(root).withContext('dossier renders when open').not.toBeNull();
    expect(root?.getAttribute('role')).toBe('dialog');
    expect(root?.getAttribute('aria-modal')).toBe('true');
    // cdkTrapFocus keeps Tab inside the takeover.
    expect(root?.hasAttribute('cdkTrapFocus')).withContext('focus is trapped').toBeTrue();
  });

  it('re-parents the overlay to <body> on open so the sidebar can never cover it', () => {
    // The dossier is declared inside a deeply-nested admin section; its
    // `z-index:100000` is trapped unless the fixed root sits at the document
    // level. Assert the rendered root's parent is <body>, not the component host.
    open();
    const root = dossierRoot();
    expect(root).withContext('overlay renders when open').not.toBeNull();
    expect(root?.parentElement).withContext('overlay lives directly under <body>').toBe(document.body);
    expect((fixture.nativeElement as HTMLElement).contains(root)).withContext('not trapped under host').toBeFalse();
  });

  it('removes the body-mounted overlay on close (no orphan left behind)', () => {
    open();
    expect(dossierRoot()).withContext('mounted while open').not.toBeNull();
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    expect(dossierRoot()).withContext('gone from <body> on close').toBeNull();
  });

  it('locks background page scroll while open, restores it on close', () => {
    open();
    expect(document.body.style.overflow).withContext('body scroll locked while open').toBe('hidden');
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    expect(document.body.style.overflow).withContext('body scroll restored on close').not.toBe('hidden');
  });

  it('Escape emits closed when open', () => {
    open();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => (closed += 1));
    fixture.componentInstance.onEscape();
    expect(closed).toBe(1);
  });

  it('restores body scroll on destroy (never leaves the page frozen)', () => {
    open();
    expect(document.body.style.overflow).toBe('hidden');
    fixture.destroy();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  /**
   * fire-69 — embarrassingly-easy / no-dead-control: when the dossier documents a
   * feature the owner's plan DOESN'T include (`entitled` is a lock state), the spec
   * sheet must say WHY it's locked AND offer a one-click upgrade CTA → inline-checkout
   * at /admin/billing. A locked capability with no visible reason + no path to unlock
   * is the exact dead-control bug being fixed. The upgrade banner is the RED driver —
   * the dossier never surfaced the entitlement lock before.
   */
  describe('fire-69 — entitlement lock banner + one-click upgrade CTA', () => {
    function openLocked(entitled: 'upgrade-required' | 'addon-required'): HTMLElement {
      fixture.componentRef.setInput('model', { ...MODEL, entitled });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();
      return document.querySelector('[data-testid="feature-dossier"]') as HTMLElement;
    }

    it('shows the upgrade lock banner + reason + CTA when the plan lacks the feature', () => {
      const root = openLocked('upgrade-required');
      const banner = root.querySelector('[data-testid="fd-upgrade-cta"]');
      expect(banner).withContext('locked banner renders').not.toBeNull();
      // The reason names the required plan (no mystery-locked control).
      expect(banner?.textContent ?? '').toContain('pro');
      const cta = root.querySelector('[data-testid="fd-upgrade-link"]') as HTMLAnchorElement | null;
      expect(cta).withContext('one-click upgrade CTA present').not.toBeNull();
      expect(cta?.getAttribute('href') ?? '').toContain('/admin/billing');
      expect(cta?.textContent ?? '').toContain('Upgrade to pro');
    });

    it('reads as an add-on unlock (not a plan upgrade) when entitled is addon-required', () => {
      const root = openLocked('addon-required');
      const cta = root.querySelector('[data-testid="fd-upgrade-link"]');
      expect(cta?.textContent ?? '').toContain('Add as an add-on');
    });

    it('shows NO upgrade banner when the feature is available (entitled) or a plain flag', () => {
      fixture.componentRef.setInput('model', { ...MODEL, entitled: 'available' });
      fixture.componentRef.setInput('open', true);
      fixture.detectChanges();
      const root = document.querySelector('[data-testid="feature-dossier"]');
      expect(root?.querySelector('[data-testid="fd-upgrade-cta"]'))
        .withContext('available feature is not locked').toBeNull();
    });
  });
});
