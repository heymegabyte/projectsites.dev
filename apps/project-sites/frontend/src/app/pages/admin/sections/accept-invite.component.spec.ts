import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';
import { AdminAcceptInviteComponent } from './accept-invite.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AuthService } from '../../../services/auth.service';

/**
 * First coverage for the team-invite acceptance flow (security-relevant auth, untested):
 *  - missing ?token → error state, helpful message, no POST fired
 *  - accept success → success state + role toast + delayed redirect to /admin
 *  - accept error → error state with the server message
 *  - goAdmin navigates
 * overrideComponent strips the template; ngOnInit() is driven directly per token stub.
 */
function make(token: string | null, post: jasmine.Spy): {
  c: AdminAcceptInviteComponent;
  nav: jasmine.Spy;
  post: jasmine.Spy;
  toast: { success: jasmine.Spy; error: jasmine.Spy };
  auth: { logout: jasmine.Spy };
} {
  const nav = jasmine.createSpy('navigateByUrl');
  const toast = { success: jasmine.createSpy('success'), error: jasmine.createSpy('error') };
  const auth = { logout: jasmine.createSpy('logout') };
  TestBed.configureTestingModule({
    imports: [AdminAcceptInviteComponent],
    providers: [
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => token } } } },
      { provide: Router, useValue: { navigateByUrl: nav } },
      { provide: ApiService, useValue: { post } },
      { provide: ToastService, useValue: toast },
      { provide: AuthService, useValue: auth },
    ],
  });
  TestBed.overrideComponent(AdminAcceptInviteComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(AdminAcceptInviteComponent).componentInstance, nav, post, toast, auth };
}

describe('AdminAcceptInviteComponent (invite acceptance flow)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('errors with a helpful message and fires no request when the token is missing', () => {
    const post = jasmine.createSpy('post');
    const { c } = make(null, post);
    c.ngOnInit();
    expect(c.state()).toBe('error');
    expect(c.message()).toContain('Missing token');
    expect(post).not.toHaveBeenCalled();
  });

  it('on success moves to the success state, toasts the role, and redirects to /admin', fakeAsync(() => {
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { joined: true, role: 'editor' } }));
    const { c, nav, toast } = make('tok-123', post);
    c.ngOnInit();
    expect(c.state()).toBe('success');
    expect(toast.success).toHaveBeenCalledWith('Joined as editor');
    expect(nav).not.toHaveBeenCalled(); // redirect is delayed
    tick(1200);
    expect(nav).toHaveBeenCalledWith('/admin');
  }));

  it('surfaces the server message on an accept error', () => {
    const post = jasmine.createSpy('post').and.returnValue(
      throwError(() => ({ error: { error: { message: 'Invite already used' } } })),
    );
    const { c } = make('tok-123', post);
    c.ngOnInit();
    expect(c.state()).toBe('error');
    expect(c.message()).toBe('Invite already used');
  });

  it('falls back to a generic message when the error has no detail', () => {
    const post = jasmine.createSpy('post').and.returnValue(throwError(() => ({ status: 500 })));
    const { c } = make('tok-123', post);
    c.ngOnInit();
    expect(c.state()).toBe('error');
    expect(c.message()).toBe('Invite could not be accepted.');
  });

  it('goAdmin navigates to the dashboard', () => {
    const { c, nav } = make('tok-123', jasmine.createSpy('post').and.returnValue(of({ data: {} })));
    c.goAdmin();
    expect(nav).toHaveBeenCalledWith('/admin');
  });

  it('accepts the invite with {silent:true} so the error panel is the sole failure surface (no generic double-toast)', () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { joined: true, role: 'editor' } }));
    const { c } = make('tok-123', post);
    c.ngOnInit();
    expect(post).toHaveBeenCalledWith('/team/invites/accept', { token: 'tok-123' }, { silent: true });
  });

  it('WRONG_USER → captures errorCode + switchAccount() logs out and returns to /signin with the accept token preserved', () => {
    // The invitee is signed into the wrong account. The embarrassingly-easy recovery: one click
    // that signs out + returns to THIS accept URL as returnUrl → auto-accepts after the right sign-in.
    const post = jasmine.createSpy('post').and.returnValue(
      throwError(() => ({
        error: { error: { code: 'WRONG_USER', message: 'This invite was sent to a@b.com; sign in as that account first.' } },
      })),
    );
    const { c, nav, auth } = make('tok-xyz', post);
    c.ngOnInit();
    expect(c.state()).toBe('error');
    expect(c.errorCode()).toBe('WRONG_USER');

    c.switchAccount();
    expect(auth.logout).toHaveBeenCalled();
    const target = nav.calls.mostRecent().args[0] as string;
    expect(target).toContain('/signin?returnUrl=');
    // the returnUrl round-trips this accept URL WITH its token so the invite reopens automatically
    expect(decodeURIComponent(target)).toContain('/admin/accept-invite?token=tok-xyz');
  });
});

/**
 * WCAG 4.1.3 status messages: the verifying/success/error transitions must be
 * announced to assistive tech. The card carries a live region — role=alert
 * (assertive) on error, role=status (polite) otherwise; aria-busy while
 * verifying. Real-template render (the stripped harness above can't see it).
 */
import { ActivatedRoute as AR2, Router as R2 } from '@angular/router';
describe('AdminAcceptInviteComponent (state region is an announced live region)', () => {
  afterEach(() => TestBed.resetTestingModule());
  function render(token: string | null, post: jasmine.Spy): HTMLElement {
    TestBed.configureTestingModule({
      imports: [AdminAcceptInviteComponent],
      providers: [
        { provide: AR2, useValue: { snapshot: { queryParamMap: { get: () => token } } } },
        { provide: R2, useValue: { navigateByUrl: () => 0 } },
        { provide: ApiService, useValue: { post } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0 } },
        { provide: AuthService, useValue: { logout: () => 0 } },
      ],
    });
    const fx = TestBed.createComponent(AdminAcceptInviteComponent);
    fx.detectChanges(); // ngOnInit
    return fx.nativeElement as HTMLElement;
  }

  it('error state → role=alert + aria-live=assertive', () => {
    const host = render(null, jasmine.createSpy('post')); // missing token → error
    const sec = host.querySelector('section.card')!;
    expect(sec.getAttribute('role')).toBe('alert');
    expect(sec.getAttribute('aria-live')).toBe('assertive');
  });

  it('success state → role=status + aria-live=polite', () => {
    const host = render('tok', jasmine.createSpy('post').and.returnValue(of({ data: { joined: true, role: 'member' } })));
    const sec = host.querySelector('section.card')!;
    expect(sec.getAttribute('role')).toBe('status');
    expect(sec.getAttribute('aria-live')).toBe('polite');
  });
});

/**
 * Cockpit cyan/black polish: each state frames its glyph in an accent-tinted halo
 * (not a bare floating char), and the verifying state shows a cyan spinner so the
 * recipient sees progress instead of static text. Decorative glyphs are
 * aria-hidden (the live-region heading carries the meaning).
 */
import { ActivatedRoute as AR3, Router as R3 } from '@angular/router';
describe('AdminAcceptInviteComponent (cyan/black glyph-halo polish)', () => {
  afterEach(() => TestBed.resetTestingModule());
  function render(token: string | null, post: jasmine.Spy): HTMLElement {
    TestBed.configureTestingModule({
      imports: [AdminAcceptInviteComponent],
      providers: [
        { provide: AR3, useValue: { snapshot: { queryParamMap: { get: () => token } } } },
        { provide: R3, useValue: { navigateByUrl: () => 0 } },
        { provide: ApiService, useValue: { post } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0 } },
        { provide: AuthService, useValue: { logout: () => 0 } },
      ],
    });
    const fx = TestBed.createComponent(AdminAcceptInviteComponent);
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  }

  it('verifying → a cyan spinner glyph (visible progress, not just static text)', () => {
    const host = render('tok', jasmine.createSpy('post').and.returnValue(new Subject())); // pending → stays verifying
    const glyph = host.querySelector('[data-testid="invite-glyph"]');
    expect(glyph).withContext('glyph halo present').toBeTruthy();
    expect(glyph!.getAttribute('aria-hidden')).withContext('decorative — heading carries meaning').toBe('true');
    expect(host.querySelector('.invite-spinner')).withContext('cyan spinner while verifying').toBeTruthy();
  });

  it('success frames the ✓ in an emerald halo (not a bare floating char)', () => {
    const ok = render('tok', jasmine.createSpy('post').and.returnValue(of({ data: { joined: true, role: 'member' } })));
    expect(ok.querySelector('.invite-glyph--success')).withContext('success halo').toBeTruthy();
  });

  it('error frames the ⚠ in an amber halo', () => {
    const err = render(null, jasmine.createSpy('post')); // missing token → error
    expect(err.querySelector('.invite-glyph--warn')).withContext('error halo').toBeTruthy();
  });

  // WCAG 2.4.6 / document outline: this is a standalone landing page (child of the
  // admin shell, which renders NO <h1>). Every sibling admin section uses <h1> as its
  // top-level heading; accept-invite shipped only <h2>, so a screen-reader user
  // navigating by heading landed on an h2 with no h1 above it (a broken outline).
  // The state heading must be the page's <h1> in EVERY state.
  it('verifying state exposes the page heading as an <h1> (not a stray <h2> with no h1 above)', () => {
    const host = render('tok', jasmine.createSpy('post').and.returnValue(new Subject()));
    expect(host.querySelector('h2')).withContext('no stray h2 as the top heading').toBeFalsy();
    expect(host.querySelector('h1')!.textContent).withContext('verifying h1').toContain('Verifying');
  });

  it('success state exposes the page heading as an <h1>', () => {
    const ok = render('tok', jasmine.createSpy('post').and.returnValue(of({ data: { joined: true, role: 'member' } })));
    expect(ok.querySelector('h2')).toBeFalsy();
    expect(ok.querySelector('h1')!.textContent).withContext('success h1').toContain('Joined');
  });

  it('error state exposes the page heading as an <h1>', () => {
    const err = render(null, jasmine.createSpy('post'));
    expect(err.querySelector('h2')).toBeFalsy();
    expect(err.querySelector('h1')!.textContent).withContext('error h1').toContain("Couldn't accept");
  });

  // The success/error glyphs must be monochrome stroke SVGs (currentColor) — the
  // ⚠ char (U+26A0) is emoji-presentation by DEFAULT, so it rendered as a colorful
  // ⚠️ emoji ignoring the amber CSS color, off-brand in the cyan/black cockpit.
  it('success ✓ renders as a monochrome stroke SVG (currentColor), not an emoji char', () => {
    const ok = render('tok', jasmine.createSpy('post').and.returnValue(of({ data: { joined: true, role: 'member' } })));
    const okSvg = ok.querySelector('.invite-glyph--success svg');
    expect(okSvg).withContext('success ✓ is a stroke SVG').toBeTruthy();
    expect(okSvg!.getAttribute('stroke')).withContext('inherits the emerald glyph color').toBe('currentColor');
  });

  it('error ⚠ renders as a monochrome stroke SVG, not the colorful U+26A0 emoji', () => {
    const err = render(null, jasmine.createSpy('post'));
    const errSvg = err.querySelector('.invite-glyph--warn svg');
    expect(errSvg).withContext('warn ⚠ is a stroke SVG, not a colorful emoji').toBeTruthy();
    expect(errSvg!.getAttribute('stroke')).withContext('inherits the amber glyph color').toBe('currentColor');
  });
});
