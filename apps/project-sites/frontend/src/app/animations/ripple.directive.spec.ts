import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RippleDirective } from './ripple.directive';

@Component({
  standalone: true,
  imports: [RippleDirective],
  template: `<button psRipple [psRippleColor]="color" [psRippleDuration]="dur">x</button>`,
})
class HostComponent {
  color = 'rgba(1, 2, 3, 0.5)';
  dur = 300;
}

describe('RippleDirective (signal inputs)', () => {
  function render() {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fx = TestBed.createComponent(HostComponent);
    fx.detectChanges();
    return fx.nativeElement.querySelector('button') as HTMLElement;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('emits a ripple span using the bound psRippleColor + psRippleDuration on pointerdown', () => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: false } as unknown as MediaQueryList);
    const btn = render();
    btn.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5 }));
    const ink = btn.querySelector('.ps-ripple-ink') as HTMLElement | null;
    expect(ink).not.toBeNull();
    // The signal inputs must reach the inline style (proves input() migration works).
    expect(ink!.style.cssText).toContain('rgba(1, 2, 3, 0.5)');
    expect(ink!.style.cssText).toContain('300ms');
  });

  it('skips the ripple entirely under prefers-reduced-motion', () => {
    spyOn(window, 'matchMedia').and.returnValue({ matches: true } as unknown as MediaQueryList);
    const btn = render();
    btn.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5 }));
    expect(btn.querySelector('.ps-ripple-ink')).toBeNull();
  });
});
