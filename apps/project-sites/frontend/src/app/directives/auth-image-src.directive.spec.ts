import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AuthImageSrcDirective } from './auth-image-src.directive';
import { ApiService } from '../services/api.service';

/**
 * Locks the authed-<img> loader. A plain `<img src="/api/…">` sends no Bearer
 * (auth is bearer-only) → 401 → broken image; the directive must fetch the bytes
 * WITH auth (ApiService.getBlobAbsolute), bind an object URL, and revoke it on
 * change/destroy. See the `plain-navigation-cant-carry-bearer` project memory.
 */
@Component({
  standalone: true,
  imports: [AuthImageSrcDirective],
  template: `<img [appAuthImageSrc]="src()" alt="t" />`,
})
class HostComponent {
  src = signal<string | null>('/api/sites/s1/snapshots/x/screenshot.png');
}

describe('AuthImageSrcDirective (authed <img> via blob)', () => {
  let getBlobAbsolute: jasmine.Spy;

  function render(): ComponentFixture<HostComponent> {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: ApiService, useValue: { getBlobAbsolute } }],
    });
    const fx = TestBed.createComponent(HostComponent);
    fx.detectChanges(); // first CD → ngOnChanges fires with the initial src
    return fx;
  }

  afterEach(() => TestBed.resetTestingModule());

  const img = (fx: ComponentFixture<HostComponent>) =>
    (fx.nativeElement as HTMLElement).querySelector('img') as HTMLImageElement;

  it('fetches the authed blob (silent) and binds an object URL — never a bare /api src that 401s', () => {
    getBlobAbsolute = jasmine.createSpy('getBlobAbsolute').and.returnValue(of(new Blob(['x'], { type: 'image/png' })));
    spyOn(URL, 'createObjectURL').and.returnValue('blob:img');
    const fx = render();
    expect(getBlobAbsolute).toHaveBeenCalledWith('/api/sites/s1/snapshots/x/screenshot.png', { silent: true });
    expect(img(fx).getAttribute('src')).withContext('binds the object URL, not the /api path').toBe('blob:img');
  });

  it('a null src removes the src attribute + never fetches', () => {
    getBlobAbsolute = jasmine.createSpy('getBlobAbsolute').and.returnValue(of(new Blob(['x'])));
    const fx = render();
    getBlobAbsolute.calls.reset();
    fx.componentInstance.src.set(null);
    fx.detectChanges();
    expect(img(fx).hasAttribute('src')).withContext('blank when no source').toBeFalse();
    expect(getBlobAbsolute).not.toHaveBeenCalled();
  });

  it('a fetch failure leaves the img blank (silent — never throws)', () => {
    getBlobAbsolute = jasmine.createSpy('getBlobAbsolute').and.returnValue(throwError(() => ({ status: 401 })));
    expect(() => render()).not.toThrow();
    expect(getBlobAbsolute).toHaveBeenCalled();
  });

  it('revokes the object URL on destroy (no leak)', () => {
    getBlobAbsolute = jasmine.createSpy('getBlobAbsolute').and.returnValue(of(new Blob(['x'])));
    spyOn(URL, 'createObjectURL').and.returnValue('blob:img');
    const revoke = spyOn(URL, 'revokeObjectURL');
    const fx = render();
    fx.destroy();
    expect(revoke).withContext('revokes on destroy').toHaveBeenCalledWith('blob:img');
  });

  it('revokes the prior object URL when the src changes (no leak across swaps)', () => {
    getBlobAbsolute = jasmine.createSpy('getBlobAbsolute').and.returnValue(of(new Blob(['x'])));
    const createSpy = spyOn(URL, 'createObjectURL').and.returnValues('blob:one', 'blob:two');
    const revoke = spyOn(URL, 'revokeObjectURL');
    const fx = render();
    expect(img(fx).getAttribute('src')).toBe('blob:one');
    fx.componentInstance.src.set('/api/sites/s1/snapshots/y/screenshot.png');
    fx.detectChanges();
    expect(revoke).withContext('old URL revoked before binding the new one').toHaveBeenCalledWith('blob:one');
    expect(img(fx).getAttribute('src')).toBe('blob:two');
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  // The effect's onCleanup unsubscribes the prior fetch on a src change, so a SLOW
  // old fetch that resolves late can never bind a stale object URL over the newer
  // src (a latent race the old ngOnChanges version did not guard).
  it('cancels an in-flight fetch when src changes (a slow old blob never overwrites the new)', () => {
    const slowFirst = new Subject<Blob>();
    getBlobAbsolute = jasmine
      .createSpy('getBlobAbsolute')
      .and.returnValues(slowFirst, of(new Blob(['2'])));
    // The first (pending) fetch never emits → never creates an object URL; only the
    // second (resolved) fetch does. So createObjectURL fires exactly once → 'blob:new'.
    const createSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:new');
    const fx = render(); // subscribes to the still-pending first fetch
    fx.componentInstance.src.set('/api/sites/s1/snapshots/y/screenshot.png');
    fx.detectChanges(); // onCleanup unsubscribes the first; the second resolves → 'blob:new'
    expect(img(fx).getAttribute('src')).toBe('blob:new');
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The old fetch resolving LATE is ignored (its subscription was cancelled) — it must
    // NOT create a second object URL or rebind a stale src.
    slowFirst.next(new Blob(['1']));
    expect(img(fx).getAttribute('src')).withContext('stale fetch ignored').toBe('blob:new');
    expect(createSpy).withContext('stale fetch never bound a second URL').toHaveBeenCalledTimes(1);
  });
});
