import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RollingCounterComponent } from './rolling-counter.component';

/**
 * Contract for the cinematic rolling-counter — the primitive every projectsites
 * stat renders through (the cinematic-ui mandate). A regression here replicates
 * across the whole admin + marketing surface, so lock the load-bearing bits:
 *  - prefers-reduced-motion → SNAP to the final value (no animation), and the
 *    same snap path serves SSR / no-IntersectionObserver
 *  - the host `aria-label` ALWAYS equals the final formatted value so assistive
 *    tech hears the meaningful number (never the rolling intermediates)
 *  - format applies prefix + suffix + decimals + locale thousands separators
 *  - host carries role=text + aria-live=off (no SR spam during the count)
 *
 * matchMedia is stubbed to reduced-motion so the snap path runs deterministically
 * (no requestAnimationFrame timing in the test).
 */
describe('RollingCounterComponent (cinematic stat primitive)', () => {
  beforeEach(() => {
    spyOn(window, 'matchMedia').and.returnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList);
  });
  afterEach(() => TestBed.resetTestingModule());

  function render(inputs: {
    value?: number;
    suffix?: string;
    prefix?: string;
    decimals?: number;
    duration?: number;
    locale?: string;
    threshold?: number;
  } = {}): ComponentFixture<RollingCounterComponent> {
    TestBed.configureTestingModule({ imports: [RollingCounterComponent] });
    const fx = TestBed.createComponent(RollingCounterComponent);

    // Set signal inputs via fixture.componentRef.setInput()
    if (inputs.value !== undefined) {
      fx.componentRef.setInput('value', inputs.value);
    }
    if (inputs.suffix !== undefined) {
      fx.componentRef.setInput('suffix', inputs.suffix);
    }
    if (inputs.prefix !== undefined) {
      fx.componentRef.setInput('prefix', inputs.prefix);
    }
    if (inputs.decimals !== undefined) {
      fx.componentRef.setInput('decimals', inputs.decimals);
    }
    if (inputs.duration !== undefined) {
      fx.componentRef.setInput('duration', inputs.duration);
    }
    if (inputs.locale !== undefined) {
      fx.componentRef.setInput('locale', inputs.locale);
    }
    if (inputs.threshold !== undefined) {
      fx.componentRef.setInput('threshold', inputs.threshold);
    }

    fx.detectChanges(); // ngOnInit → reduced-motion snap
    return fx;
  }
  const text = (fx: ComponentFixture<RollingCounterComponent>): string =>
    (fx.nativeElement.querySelector('span')?.textContent ?? '').trim();
  const aria = (fx: ComponentFixture<RollingCounterComponent>): string | null =>
    (fx.nativeElement as HTMLElement).getAttribute('aria-label');

  it('reduced-motion snaps straight to the final formatted value (no animation)', () => {
    const fx = render({ value: 1234 });
    expect(text(fx)).toBe('1,234');
  });

  it('aria-label always equals the final formatted value (AT hears the truth, not the roll)', () => {
    const fx = render({ value: 99.99, suffix: '%', decimals: 2 });
    expect(aria(fx)).toBe('99.99%');
  });

  it('format applies prefix + thousands separators + decimals (text AND aria match)', () => {
    const fx = render({ value: 50000, prefix: '$', decimals: 2 });
    expect(text(fx)).toBe('$50,000.00');
    expect(aria(fx)).toBe('$50,000.00');
  });

  it('host is role=text + aria-live=off so the rolling count never spams a screen reader', () => {
    const fx = render({ value: 5 });
    const host = fx.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('text');
    expect(host.getAttribute('aria-live')).toBe('off');
  });
});
