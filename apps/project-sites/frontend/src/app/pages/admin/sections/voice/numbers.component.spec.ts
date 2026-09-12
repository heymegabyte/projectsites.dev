import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError, Subject } from 'rxjs';
import { VoiceNumbersComponent } from './numbers.component';
import { ApiService } from '../../../../services/api.service';
import { ToastService } from '../../../../services/toast.service';
import { ConfirmService } from '../../../../services/confirm.service';
import { AdminStateService } from '../../admin-state.service';

/**
 * First coverage for the voice number purchase/release flow. The buy + release
 * actions move money / give up a live number — both must go through the BRANDED
 * cyan ConfirmService (not the old native window.confirm), and must NOT hit the
 * API when the user cancels. overrideComponent strips the template so the
 * site-load effect doesn't auto-fire; methods are driven directly.
 */
function make(confirmResult = true): {
  c: VoiceNumbersComponent;
  api: { get: jasmine.Spy; post: jasmine.Spy; delete: jasmine.Spy };
  confirmSpy: jasmine.Spy;
} {
  const api = {
    get: jasmine.createSpy('get').and.returnValue(of({ data: [] })),
    post: jasmine.createSpy('post').and.returnValue(of({ data: {} })),
    delete: jasmine.createSpy('delete').and.returnValue(of(undefined)),
  };
  const confirmSpy = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
  TestBed.configureTestingModule({
    imports: [VoiceNumbersComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: ToastService, useValue: { success: () => 0, error: () => 0, info: () => 0 } },
      { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      { provide: ConfirmService, useValue: { confirm: confirmSpy } },
    ],
  });
  TestBed.overrideComponent(VoiceNumbersComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(VoiceNumbersComponent).componentInstance, api, confirmSpy };
}

describe('VoiceNumbersComponent (purchase + release confirmation)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('confirmBuy confirms with danger:true then POSTs the purchase', async () => {
    const { c, api, confirmSpy } = make(true);
    await c.confirmBuy({ phone_number: '+18558522267', monthly_cost_usd: 1.15 } as never);
    expect(confirmSpy).toHaveBeenCalled();
    expect((confirmSpy.calls.mostRecent().args[0] as { danger?: boolean }).danger).toBeTrue();
    expect(api.post).toHaveBeenCalledWith('/voice/numbers/purchase', { siteId: 's1', phoneNumber: '+18558522267' }, { silent: true });
  });

  it('confirmBuy does NOT POST when the buy confirm is cancelled', async () => {
    const { c, api, confirmSpy } = make(false);
    await c.confirmBuy({ phone_number: '+18558522267', monthly_cost_usd: 1.15 } as never);
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('release confirms (danger) then DELETEs; cancel → no DELETE', async () => {
    const ok = make(true);
    await ok.c.release({ id: 'n1', phone_number: '+18558522267' } as never);
    expect(ok.confirmSpy).toHaveBeenCalled();
    expect((ok.confirmSpy.calls.mostRecent().args[0] as { danger?: boolean }).danger).toBeTrue();
    expect(ok.api.delete).toHaveBeenCalledWith('/voice/numbers/n1', { silent: true });

    TestBed.resetTestingModule();
    const no = make(false);
    await no.c.release({ id: 'n1', phone_number: '+18558522267' } as never);
    expect(no.api.delete).not.toHaveBeenCalled();
  });

  // Buy CHARGES MONEY + Release is DESTRUCTIVE — both must be double-submit-safe.
  it('confirmBuy does NOT double-POST while a purchase is in flight (no double charge)', async () => {
    const { c, api } = make(true);
    api.post.and.returnValue(new Subject()); // stays pending → buy guard stays held
    const cand = { phone_number: '+18558522267', monthly_cost_usd: 1.15 } as never;
    await c.confirmBuy(cand);
    await c.confirmBuy(cand);
    expect(api.post).withContext('a second buy while the first is in flight must not fire').toHaveBeenCalledTimes(1);
  });

  it('confirmBuy clears the buy guard on error so a retry can fire (no stuck guard)', async () => {
    const { c, api } = make(true);
    api.post.and.returnValues(throwError(() => ({ status: 500 })), of({ data: {} }));
    const cand = { phone_number: '+18558522267', monthly_cost_usd: 1.15 } as never;
    await c.confirmBuy(cand);
    await c.confirmBuy(cand);
    expect(api.post).withContext('a failed buy must not block the retry').toHaveBeenCalledTimes(2);
  });

  it('release does NOT double-DELETE the same number while in flight', async () => {
    const { c, api } = make(true);
    api.delete.and.returnValue(new Subject());
    const n = { id: 'n1', phone_number: '+18558522267' } as never;
    await c.release(n);
    await c.release(n);
    expect(api.delete).withContext('a second release of the same number must not fire').toHaveBeenCalledTimes(1);
  });

  it('release clears the guard on error so a retry can fire', async () => {
    const { c, api } = make(true);
    api.delete.and.returnValues(throwError(() => ({ status: 500 })), of(undefined));
    const n = { id: 'n1', phone_number: '+18558522267' } as never;
    await c.release(n);
    await c.release(n);
    expect(api.delete).toHaveBeenCalledTimes(2);
  });

  it('loadNumbers failure sets loadError (not a fake empty + $0.00 spend)', () => {
    const { c, api } = make();
    api.get.and.returnValue(throwError(() => ({ status: 500 })));
    c.loadNumbers();
    expect(c.loadError()).toContain('did not respond');
    expect(c.loading()).toBeFalse();
  });

  it('a transient load failure PRESERVES already-loaded numbers (no wipe → no false $0 spend)', () => {
    const { c, api } = make();
    // Worker GET /api/voice/numbers returns { numbers }, not { data } (voice.ts:310).
    api.get.and.returnValue(of({ numbers: [{ id: 'n1', monthly_cost_usd: 1.15 }, { id: 'n2', monthly_cost_usd: 2 }] }));
    c.loadNumbers();
    expect(c.numbers().length).toBe(2);
    api.get.and.returnValue(throwError(() => ({ status: 503 })));
    c.loadNumbers();
    expect(c.numbers().length).withContext('numbers survive a transient failure').toBe(2);
    expect(c.loadError()).toBeTruthy();
  });

  // Regression: reading r.data (the old bug) hid the site's purchased numbers
  // behind "No numbers yet" + a false $0.00 spend. A { data }-only response must
  // now populate NOTHING — proving loadNumbers reads the worker's real { numbers }.
  it('loadNumbers reads the real { numbers } key — a { data }-only response populates nothing', () => {
    const { c, api } = make();
    api.get.and.returnValue(of({ data: [{ id: 'x1', monthly_cost_usd: 5 }] }));
    c.loadNumbers();
    expect(c.numbers().length).withContext('r.data must NOT populate — only r.numbers').toBe(0);
  });

  // The vanity match is bolded with <b> (injected via [innerHTML]); the cockpit
  // styles those cyan via `:host ::ng-deep .vanity-display b` (was a dead
  // `:global(b)` rule → browser default, off-brand). Confirm the <b> markup the
  // rule targets is actually produced.
  it('vanityHtml wraps the vanity match in <b> for the cyan highlight to style', () => {
    const { c } = make();
    // (855) 522-6700 — last7 "5226700" contains LABOR's digit-map "52267".
    const html = c.vanityHtml('+18555226700', 'LABOR');
    expect(html).toContain('<b>L</b>');
    expect(html).toContain('<b>R</b>');
    // No vanity arg → plain number, no stray <b>.
    expect(c.vanityHtml('+18555226700')).not.toContain('<b>');
  });
});

/**
 * The "No matches" hint gated on `query` only, so an AREA-CODE-ONLY search
 * that returned nothing showed a silent blank (no guidance). `searchAttempted()`
 * fires for a word OR an area-code search so the empty-results hint always shows.
 */
describe('VoiceNumbersComponent (area-code-only search shows the no-results hint)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('searchAttempted() is true for a word search', () => {
    const { c } = make();
    c.query = 'FIT'; c.areaCode = '';
    expect(c.searchAttempted()).toBeTrue();
  });

  it('searchAttempted() is true for an AREA-CODE-ONLY search (the fix — no word typed)', () => {
    const { c } = make();
    c.query = ''; c.areaCode = '415';
    expect(c.searchAttempted()).withContext('area-only search still counts as a search').toBeTrue();
  });

  it('searchAttempted() is false when neither a word nor an area code is set', () => {
    const { c } = make();
    c.query = '   '; c.areaCode = '';
    expect(c.searchAttempted()).toBeFalse();
  });

  // A failed search must NOT masquerade as the "No numbers available" empty hint
  // (a lie). It sets searchError so the template shows an honest, actionable
  // notice instead — the exact class the admin-verification mandate forbids.
  it('a 501 search failure sets the connect-provider notice (never a lying empty result)', () => {
    const { c, api } = make();
    api.get.and.returnValue(throwError(() => ({ status: 501 })));
    c.query = 'MOVE';
    c.retrySearch();
    expect(c.searchResults().length).withContext('no fake results').toBe(0);
    expect(c.searchError()).withContext('honest provider notice').toContain('phone provider');
  });

  it('a non-501 search failure shows the transient Retry message', () => {
    const { c, api } = make();
    api.get.and.returnValue(throwError(() => ({ status: 503 })));
    c.query = 'MOVE';
    c.retrySearch();
    expect(c.searchError()).toContain('Retry');
  });

  it('a successful search clears any prior searchError and populates results', () => {
    const { c, api } = make();
    c.searchError.set('stale');
    api.get.and.returnValue(
      of({ numbers: [{ phone_number: '+18005550100', iso_country: 'US', capabilities: { voice: true, sms: true, mms: false }, monthly_cost_usd: 1.15 }] }),
    );
    c.query = 'MOVE';
    c.retrySearch();
    expect(c.searchError()).toBeNull();
    expect(c.searchResults().length).toBe(1);
  });
});

/**
 * §17 Find-a-Number live keypad preview — the operator types a vanity word and
 * sees the exact digits the `contains=` search resolves to. Drives off the pure
 * vanity-keypad util; here we lock the component-level getters that the chip
 * binds to (template stripped by make()).
 */
describe('VoiceNumbersComponent (keypad-digit preview)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('queryDigits() renders the keypad digits for a vanity word', () => {
    const { c } = make();
    c.query = 'MOVE';
    expect(c.queryDigits()).toBe('6683');
    c.query = '82labor';
    expect(c.queryDigits()).toBe('8252267');
  });

  it('queryDigits() is null for digits-only or empty (no preview needed)', () => {
    const { c } = make();
    c.query = '8553334444';
    expect(c.queryDigits()).toBeNull();
    c.query = '   ';
    expect(c.queryDigits()).toBeNull();
  });

  it('queryUpper() upper-cases the trimmed word for the chip label', () => {
    const { c } = make();
    c.query = '  move  ';
    expect(c.queryUpper()).toBe('MOVE');
  });
});

/**
 * The vanity search hint must reflect the OPERATOR'S business, not a generic /
 * wrong-vertical example. `vanityExample` derives the first memorable word of the
 * selected site's business name (was a hardcoded "MOVE"/"82LABOR"/"BRICK" — those
 * are a moving company's words, shown even on a cocktail lounge). AL-137.
 */
describe('VoiceNumbersComponent — brand-aware vanity example', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeWithSite(site: unknown): VoiceNumbersComponent {
    TestBed.configureTestingModule({
      imports: [VoiceNumbersComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({ data: {} }), delete: () => of(undefined) } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0, info: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal(site) } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    TestBed.overrideComponent(VoiceNumbersComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(VoiceNumbersComponent).componentInstance;
  }

  it('derives the vanity example from the first memorable word of the business name', () => {
    const c = makeWithSite({ id: 's1', business_name: 'Lumen & Oak Cocktail Lounge' });
    expect(c.vanityExample()).toBe('LUMEN');
    expect(c.vanityPlaceholder()).toBe('Try "LUMEN", or digits');
  });

  it('skips leading articles (the/and) when picking the example word', () => {
    const c = makeWithSite({ id: 's2', business_name: 'The Roasted Bean' });
    expect(c.vanityExample()).toBe('ROASTED');
  });

  it('caps the example at 7 letters (a local number is 7 keypad digits)', () => {
    const c = makeWithSite({ id: 's3', business_name: 'Constellation Bistro' });
    expect(c.vanityExample()).toBe('CONSTEL');
  });

  it('falls back to HELLO with no site or an unusable name', () => {
    expect(makeWithSite(null).vanityExample()).toBe('HELLO');
    TestBed.resetTestingModule(); // second config needs a fresh module (else "already instantiated")
    expect(makeWithSite({ id: 's4', business_name: '' }).vanityExample()).toBe('HELLO');
  });
});

/**
 * The 0-numbers empty state's "Find a vanity number" CTA calls focusSearch() so an
 * operator doesn't have to hunt down the page for the picker (on mobile the search input
 * sits ~3 screens below the empty state — the old "Pick a vanity word below" copy pointed
 * at nothing reachable). extra-mile: empty state → first-result action. (ADMIN INTEGRITY.)
 */
describe('VoiceNumbersComponent — focusSearch (empty-state → first-result action)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function bare(): VoiceNumbersComponent {
    TestBed.configureTestingModule({
      imports: [VoiceNumbersComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({ data: {} }), delete: () => of(undefined) } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0, info: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    TestBed.overrideComponent(VoiceNumbersComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(VoiceNumbersComponent).componentInstance;
  }

  it('focuses the search input (preventScroll) AND scrolls it into view', () => {
    const c = bare();
    const focus = jasmine.createSpy('focus');
    const scrollIntoView = jasmine.createSpy('scrollIntoView');
    (c as unknown as { searchInputRef: unknown }).searchInputRef = { nativeElement: { focus, scrollIntoView } };
    c.focusSearch();
    // focus must NOT scroll (preventScroll) so the smooth scrollIntoView owns the motion.
    expect(focus).toHaveBeenCalledOnceWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.calls.mostRecent().args[0] as { block?: string }).block).toBe('center');
  });

  it('no-ops safely when the search input ref is not yet resolved (no throw)', () => {
    const c = bare();
    (c as unknown as { searchInputRef: unknown }).searchInputRef = undefined;
    expect(() => c.focusSearch()).not.toThrow();
  });
});
