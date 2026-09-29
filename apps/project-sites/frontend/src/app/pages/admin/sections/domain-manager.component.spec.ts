/**
 * DomainManagerComponent — Jasmine/Karma unit tests.
 *
 * @remarks
 * The project uses Karma + Jasmine (`ng test` / `npm run test:ci`) — no Vitest
 * or Jest. This suite guards the URL-manager popover's WAI-ARIA dialog contract
 * (the Domains VQA a11y pass, fire-51):
 *  - the popover renders `role="dialog"` + `aria-modal="true"` when open
 *  - opening moves focus INTO the popover (focus-trap via `FocusTrapDirective`)
 *  - `Escape` closes the popover AND restores focus to the trigger button
 *  - the app's existing focus-trap primitive is reused (never hand-rolled)
 *
 * It attaches the fixture to `document.body` so the real focus model + the
 * directive's `document.addEventListener('keydown', …, true)` capture handler
 * behave as they do in the browser (mirrors `focus-trap.directive.spec.ts`).
 *
 * @see focus-trap.directive.spec.ts — the shared harness conventions.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';
import { DomainManagerComponent } from './domain-manager.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

/** Dispatch a bubbling, cancelable keydown on `target` (document or element). */
function dispatchKey(target: Document | Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('DomainManagerComponent (URL popover a11y)', () => {
  let fixture: ComponentFixture<DomainManagerComponent>;

  function build(): void {
    // `loadDomains` fires on open — return an empty domain list so the popover
    // renders with only its always-present controls (slug input, buy input, …).
    const api = { get: () => of({ domains: [] }), post: () => of({}), delete: () => of({}) };
    const toast = { success: () => undefined, error: () => undefined };

    TestBed.configureTestingModule({
      imports: [DomainManagerComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toast },
      ],
    });
    fixture = TestBed.createComponent(DomainManagerComponent);
    // Required inputs (all `input.required`).
    fixture.componentRef.setInput('instanceId', 'inst_1');
    fixture.componentRef.setInput('appId', 'app_1');
    fixture.componentRef.setInput('host', 'acme.cms.projectsites.dev');
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  }

  function trigger(): HTMLButtonElement {
    return fixture.nativeElement.querySelector(
      '[data-testid="domain-manager-trigger"]',
    ) as HTMLButtonElement;
  }

  function pop(): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="domain-manager-pop"]');
  }

  beforeEach(() => build());

  afterEach(() => {
    if (fixture.nativeElement.parentNode) {
      document.body.removeChild(fixture.nativeElement);
    }
  });

  it('does not render the popover until the trigger is clicked', () => {
    expect(pop()).toBeNull();
  });

  it('renders role=dialog + aria-modal=true when open', () => {
    trigger().click();
    fixture.detectChanges();
    const el = pop();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('dialog');
    expect(el!.getAttribute('aria-modal')).toBe('true');
  });

  it('moves focus into the popover on open (focus-trap active)', async () => {
    const t = trigger();
    t.focus();
    expect(document.activeElement).toBe(t);
    t.click();
    fixture.detectChanges();
    await Promise.resolve(); // FocusTrapDirective defers initial focus via queueMicrotask
    const el = pop();
    expect(el).not.toBeNull();
    // Focus is now inside the popover, not left on the trigger.
    expect(el!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(t);
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const t = trigger();
    t.focus();
    t.click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(pop()).not.toBeNull();

    // The component's @HostListener('document:keydown.escape') closes the popover;
    // the FocusTrapDirective deactivation restores focus to the previously-focused
    // element (the trigger).
    dispatchKey(document, 'Escape');
    fixture.detectChanges();

    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(t);
  });
});
