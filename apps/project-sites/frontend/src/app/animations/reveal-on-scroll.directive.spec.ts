import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RevealOnScrollDirective } from './reveal-on-scroll.directive';

@Component({
  standalone: true,
  imports: [RevealOnScrollDirective],
  template: `<div psReveal [psRevealThreshold]="th" [psRevealMargin]="mg" [psRevealOnce]="once">x</div>`,
})
class HostComponent {
  th = 0.3;
  mg = '0px 0px -20% 0px';
  once = true;
}

describe('RevealOnScrollDirective (signal inputs)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('passes the bound psRevealThreshold + psRevealMargin to the IntersectionObserver', () => {
    let captured: IntersectionObserverInit | undefined;
    const orig = window.IntersectionObserver;
    class MockIO {
      constructor(_cb: unknown, opts?: IntersectionObserverInit) {
        captured = opts;
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
    spyOn(window, 'matchMedia').and.returnValue({ matches: false } as unknown as MediaQueryList);
    try {
      TestBed.configureTestingModule({ imports: [HostComponent] });
      TestBed.createComponent(HostComponent).detectChanges();
      // The signal inputs must reach the observer options (proves input() migration works).
      expect(captured?.threshold).toBe(0.3);
      expect(captured?.rootMargin).toBe('0px 0px -20% 0px');
    } finally {
      (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = orig;
    }
  });

  it('adds is-visible immediately under prefers-reduced-motion (never hides content)', () => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: true } as unknown as MediaQueryList);
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fx = TestBed.createComponent(HostComponent);
    fx.detectChanges();
    const el = fx.nativeElement.querySelector('div') as HTMLElement;
    expect(el.classList.contains('is-visible')).toBeTrue();
  });
});
