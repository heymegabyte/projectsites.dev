import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { RevealDirective, resetRevealOrderForTest } from './reveal.directive';

/**
 * Regression guard for the app-wide first-paint reveal animation.
 *
 * The load-bearing bug this locks: `[appReveal]` staggers hosts by a
 * module-global counter that only reset on a full page RELOAD. In the SPA the
 * counter accumulated across route navigations, so a freshly-mounted section
 * (e.g. the Apps store header after exiting My Instances) animated at a delay of
 * `index × 80ms` — seconds of opacity:0 = "the header doesn't show for a few
 * seconds." The fix: a per-render batch reset (microtask) + a hard delay cap.
 *
 * We spy on `Element.prototype.animate` and read the `delay` each host requests.
 */
@Component({
  standalone: true,
  imports: [RevealDirective],
  template: `
    <div appReveal></div>
    <div appReveal></div>
    <div appReveal></div>
  `,
})
class ThreeHostsComponent {}

@Component({
  standalone: true,
  imports: [RevealDirective],
  template: `<div appReveal [revealDelay]="9999"></div>`,
})
class HugeDelayComponent {}

@Component({
  standalone: true,
  imports: [RevealDirective],
  template: `<div appReveal></div>`,
})
class OneHostComponent {}

@Component({
  standalone: true,
  imports: [RevealDirective],
  template: `<div appReveal [revealDelay]="9999" [revealMaxDelay]="100"></div>`,
})
class CustomCapComponent {}

describe('RevealDirective (first-paint stagger + SPA batch reset)', () => {
  let delays: number[];

  beforeEach(() => {
    delays = [];
    // Clean stagger batch per test — the counter is module-global, so without
    // this a dirty counter from an earlier spec (suite-order dependent) offsets
    // the asserted indices. Makes these assertions order-independent.
    resetRevealOrderForTest();
    // Pin the directive's two animate-gating preconditions so this spec verifies
    // the stagger MATH, not the Karma-headless environment: (1) motion allowed
    // (reduce-motion would early-return → no animate), (2) host in-viewport
    // (a detached fixture's getBoundingClientRect is all-zeros → deferred to the
    // IntersectionObserver, never firing in-test). Both resolve inconsistently
    // headless + sibling specs can leave matchMedia stubbed, so adding ANY spec
    // could flip them and flake `delays` to empty. Pinning de-flakes order-wide.
    spyOn(window, 'matchMedia').and.returnValue({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as MediaQueryList);
    spyOn(Element.prototype, 'getBoundingClientRect').and.returnValue({
      top: 10,
      bottom: 100,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect);
    // Capture the delay each host asks for; return a no-op Animation.
    spyOn(Element.prototype, 'animate').and.callFake((_kf: unknown, opts: unknown) => {
      const d =
        opts && typeof opts === 'object' ? (opts as KeyframeAnimationOptions).delay : undefined;
      delays.push(typeof d === 'number' ? d : 0);
      return { cancel() {}, finish() {}, addEventListener() {} } as unknown as Animation;
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  function render<T>(cmp: { new (): T }): ComponentFixture<T> {
    TestBed.configureTestingModule({ imports: [cmp] });
    const fx = TestBed.createComponent(cmp);
    fx.detectChanges(); // ngOnInit → reveal hosts animate (they're in viewport)
    return fx;
  }

  it('staggers hosts in a single render by revealStep (0, 80, 160ms)', () => {
    render(ThreeHostsComponent);
    expect(delays.length).toBe(3);
    expect(delays).toEqual([0, 80, 160]);
  });

  it('caps the computed delay at revealMaxDelay so a host never waits "seconds"', () => {
    render(HugeDelayComponent);
    expect(delays.length).toBe(1);
    expect(delays[0]).withContext('clamped to the 480ms cap, not 9999').toBe(480);
  });

  it('honors a bound custom revealMaxDelay (signal input flows a non-default value)', () => {
    render(CustomCapComponent);
    expect(delays.length).toBe(1);
    expect(delays[0]).withContext('capped at the bound 100ms, not the 480 default').toBe(100);
  });

  it('resets the stagger batch between renders — a new route starts at 0, NOT an accumulated index', async () => {
    // First render uses indices 0,1,2.
    const fx1 = render(ThreeHostsComponent);
    fx1.destroy();
    TestBed.resetTestingModule(); // allow a fresh configureTestingModule below
    // Let the queued microtask reset the module counter (the SPA-nav boundary).
    await Promise.resolve();
    delays.length = 0;
    // A brand-new view (simulating navigating to another route) must restart at
    // index 0 — NOT continue at 3 (which would be the accumulating-delay bug).
    render(OneHostComponent);
    expect(delays.length).toBe(1);
    expect(delays[0]).withContext('fresh batch → no accumulated stagger delay').toBe(0);
  });
});
