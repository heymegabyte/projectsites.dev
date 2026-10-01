import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AdminDomainsComponent } from './domains.component';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';

/**
 * Guards the Domains section cyan/black cohesion + a11y convergence pass (round 4):
 *  - connected-domain stats render through `<app-rolling-counter>` (numeric-stat mandate)
 *  - the three surfaces keep their `appReveal` entrance hosts
 *  - the transfer-out modal honours the WAI-ARIA dialog contract
 *    (role=dialog + aria-modal + aria-labelledby + focus-trap)
 *  - the no-site guard renders an accessible empty state
 *  - `verifiedCount` derives the live-domain tally for the stat chip
 */
describe('AdminDomainsComponent (cyan/black cohesion + a11y)', () => {
  let fixture: ComponentFixture<AdminDomainsComponent>;
  let selectedSite: WritableSignal<{ id: string; slug: string } | null>;

  interface HostnameRow {
    id: string;
    hostname: string;
    type: string;
    status: string;
    ssl_status: string;
    is_primary: number;
  }

  function build(
    initial: { id: string; slug: string } | null,
    hostnames: HostnameRow[] = [],
  ): void {
    selectedSite = signal(initial);
    const api = {
      get: () => of({ data: hostnames }),
      post: () => of({ data: {} }),
      put: () => of({ data: {} }),
      delete: () => of({ data: {} }),
    };
    const toast = { success: () => undefined, error: () => undefined };
    const confirmSvc = { confirm: () => Promise.resolve(true) };

    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite } },
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toast },
        { provide: ConfirmService, useValue: confirmSvc },
      ],
    });
    fixture = TestBed.createComponent(AdminDomainsComponent);
    fixture.detectChanges();
  }

  function row(over: Partial<HostnameRow> = {}): HostnameRow {
    return {
      id: 'h1',
      hostname: 'example.com',
      type: 'custom_cname',
      status: 'active',
      ssl_status: 'active',
      is_primary: 0,
      ...over,
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  // Value-domain coverage (TDD #10) for isValidDomain — the FE gate that mirrors
  // the worker's hostnameSchema (min 3 / max 253 + RFC format). Ensures overlong /
  // too-short / malformed hostnames are caught on the client, not by a server 400.
  it('isValidDomain rejects every bad value class and accepts real hostnames', () => {
    build({ id: 's1', slug: 'vito' }, []);
    const c = fixture.componentInstance;
    // VALID (incl. trim + case-insensitive)
    expect(c.isValidDomain('www.example.com')).toBe(true);
    expect(c.isValidDomain('  EXAMPLE.co.uk  ')).toBe(true);
    expect(c.isValidDomain('a-b.co')).toBe(true);
    // EMPTY / too short (< 3)
    expect(c.isValidDomain('')).toBe(false);
    expect(c.isValidDomain('ab')).toBe(false);
    // INVALID format: no dot / scheme / spaces
    expect(c.isValidDomain('localhost')).toBe(false);
    expect(c.isValidDomain('http://x.com')).toBe(false);
    expect(c.isValidDomain('x y.com')).toBe(false);
    // OVERLONG (> 253) — format-valid but blocked by the new length gate
    const overlong = 'sub.'.repeat(70) + 'example.com'; // ~291 chars
    expect(overlong.length).toBeGreaterThan(253);
    expect(c.isValidDomain(overlong)).toBe(false);
    // UNICODE (raw, not punycode) → rejected (expects xn--)
    expect(c.isValidDomain('café.com')).toBe(false);
    // INJECTION-shaped → rejected by format
    expect(c.isValidDomain(`'; DROP TABLE hostnames;--.com`)).toBe(false);
  });

  it('the "No connected domains" empty state offers an "Add a domain" CTA that focuses the input', () => {
    build({ id: 's1', slug: 'vito' }, []); // empty → the no-domains empty state renders
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el); // focus only moves when the element is in the document
    try {
      const cta = el.querySelector('app-empty-state button.btn-primary') as HTMLButtonElement | null;
      expect(cta).withContext('empty state renders an Add-a-domain CTA').not.toBeNull();
      expect(cta?.textContent?.trim()).toBe('Add a domain');
      cta!.click();
      fixture.detectChanges();
      const input = el.querySelector('[data-testid="custom-domain-input"]');
      expect(document.activeElement).withContext('CTA focuses the add-domain input').toBe(input);
    } finally {
      el.remove();
    }
  });

  it('renders the connected-domain count through <app-rolling-counter> (numeric-stat mandate)', () => {
    build({ id: 's1', slug: 'vito' }, [row({ id: 'a' }), row({ id: 'b', status: 'pending' })]);
    const el: HTMLElement = fixture.nativeElement;
    const chip = el.querySelector('.count-chip');
    expect(chip).toBeTruthy();
    // Numeric stats are NOT raw text nodes — they flow through the rolling counter.
    expect(chip!.querySelector('app-rolling-counter')).toBeTruthy();
  });

  it('keeps the three appReveal entrance hosts when a site is selected', () => {
    build({ id: 's1', slug: 'vito' }, [row()]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('[appReveal]').length).toBeGreaterThanOrEqual(3);
  });

  // Cohesion: the panels use the cockpit `.card` (glass bg + glow border) like the
  // other 38 sections — NOT the `bg-surface` outlier, which resolved to a bare white
  // border with NO background (transparent panels on the dark page).
  it('panels use the cockpit .card class (not the bg-less bg-surface outlier)', () => {
    build({ id: 's1', slug: 'vito' }, [row()]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('section.card').length).withContext('panels are cockpit cards').toBeGreaterThanOrEqual(3);
    expect(el.querySelector('.bg-surface')).withContext('no bg-less bg-surface panels remain').toBeNull();
  });

  it('announces the hostnames loading skeleton to assistive tech (role=status + aria-busy)', () => {
    build({ id: 's1', slug: 'vito' }, [row()]);
    fixture.componentInstance.loadingHostnames.set(true);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const loading = el.querySelector('[data-testid="hostnames-loading"]');
    expect(loading).withContext('cyan loading skeleton').not.toBeNull();
    expect(loading?.getAttribute('role')).toBe('status');
    expect(loading?.getAttribute('aria-busy')).toBe('true');
  });

  it('derives connectedCount + verifiedCount from the hostname list', () => {
    build({ id: 's1', slug: 'vito' }, [
      row({ id: 'a', status: 'active' }),
      row({ id: 'b', status: 'pending_validation' }),
      row({ id: 'c', status: 'verification_failed' }),
    ]);
    const cmp = fixture.componentInstance;
    expect(cmp.connectedCount()).toBe(3);
    // Only the 'active' row maps to the 'verified' tone.
    expect(cmp.verifiedCount()).toBe(1);
  });

  it('renders an accessible empty state when no site is selected', () => {
    build(null);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-empty-state')).toBeTruthy();
    // No stat chip when there is no site/hostnames.
    expect(el.querySelector('.count-chip')).toBeNull();
  });

  it('exposes the WAI-ARIA dialog contract on the transfer-out modal', () => {
    build({ id: 's1', slug: 'vito' }, [row({ type: 'custom_cname' })]);
    const cmp = fixture.componentInstance;
    cmp.openTransferModal(row({ type: 'custom_cname' }) as never);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const panel = el.querySelector('[data-testid="transfer-modal"] [role="dialog"]');
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute('aria-modal')).toBe('true');
    expect(panel!.getAttribute('aria-labelledby')).toBe('transfer-modal-title');
    // The labelling target exists and names the dialog.
    expect(el.querySelector('#transfer-modal-title')).toBeTruthy();
    // Close control is explicitly labelled for screen readers.
    expect(el.querySelector('.modal-close')?.getAttribute('aria-label')).toBe('Close dialog');
  });

  it('closeTransferModal clears modal state', () => {
    build({ id: 's1', slug: 'vito' }, [row()]);
    const cmp = fixture.componentInstance;
    cmp.openTransferModal(row() as never);
    expect(cmp.transferModal()).not.toBeNull();
    cmp.closeTransferModal();
    expect(cmp.transferModal()).toBeNull();
  });

  it('maps hostname statuses to the four perceptual tones', () => {
    build({ id: 's1', slug: 'vito' });
    const cmp = fixture.componentInstance;
    expect(cmp.statusTone('active')).toBe('verified');
    expect(cmp.statusTone('pending_validation')).toBe('pending');
    expect(cmp.statusTone('verification_failed')).toBe('error');
    expect(cmp.statusTone('weird')).toBe('neutral');
  });
});

/**
 * Guards the hostname-load error gating (round): a failed `/hostnames` fetch used
 * to fall through to the "No connected domains" empty state — a masquerade that
 * could prompt a re-provision of a domain the user already owns. Now it sets a
 * persistent hostnamesError card with Retry; success/retry clear it.
 */
describe('AdminDomainsComponent (hostname load-error gating)', () => {
  function makeErroring(get: jasmine.Spy): { c: AdminDomainsComponent; toastErr: jasmine.Spy } {
    const toastErr = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get, post: () => of({}), put: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: toastErr, success: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    TestBed.overrideComponent(AdminDomainsComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminDomainsComponent).componentInstance, toastErr };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('success leaves hostnamesError null and populates the list', () => {
    const { c } = makeErroring(jasmine.createSpy('get').and.returnValue(of({ data: [{ id: 'h1' }] })));
    c.loadHostnames();
    expect(c.hostnamesError()).toBeNull();
    expect(c.hostnames().length).toBe(1);
    expect(c.loadingHostnames()).toBe(false);
  });

  it('a load error sets a persistent hostnamesError banner WITHOUT a toast (banner+Retry is the UX)', () => {
    const get = jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 })));
    const { c, toastErr } = makeErroring(get);
    c.loadHostnames();
    expect(c.hostnamesError()).toContain('Could not load');
    expect(c.hostnames().length).toBe(0);
    expect(c.loadingHostnames()).toBe(false);
    // The inline banner + Retry is the sole feedback — no own toast, and the GET
    // is {silent} so ApiService's generic toast can't double-fire over it.
    expect(toastErr).not.toHaveBeenCalled();
    expect(get.calls.mostRecent().args[2]).toEqual({ silent: true });
  });

  it('retry after an error clears the prior hostnamesError', () => {
    const get = jasmine.createSpy('get').and.returnValues(throwError(() => ({ status: 500 })), of({ data: [] }));
    const { c } = makeErroring(get);
    c.loadHostnames();
    expect(c.hostnamesError()).not.toBeNull();
    c.loadHostnames();
    expect(c.hostnamesError()).toBeNull();
  });

  it('captures the worker request_id from a failed load → hostnamesErrorRef (copyable support reference on the shared error card)', () => {
    const get = jasmine
      .createSpy('get')
      .and.returnValue(throwError(() => ({ status: 500, error: { error: { request_id: 'req_abc123' } } })));
    const { c } = makeErroring(get);
    c.loadHostnames();
    expect(c.hostnamesErrorRef()).toBe('req_abc123');
  });

  it('resets hostnamesErrorRef at the start of every load (no stale reference)', () => {
    const get = jasmine
      .createSpy('get')
      .and.returnValues(throwError(() => ({ status: 500, error: { error: { request_id: 'req_x' } } })), of({ data: [] }));
    const { c } = makeErroring(get);
    c.loadHostnames();
    expect(c.hostnamesErrorRef()).toBe('req_x');
    c.loadHostnames();
    expect(c.hostnamesErrorRef()).toBe('');
  });
});

/**
 * Add-custom-domain validation: the "Add domain" button is disabled for an
 * invalid value, but a greyed-out button with no reason is a silent dead-end.
 * This locks: (1) `customDomainInvalid` only flags a NON-EMPTY malformed value
 * (no nagging before the user types); (2) a visible inline hint + `aria-invalid`
 * explain the disabled state; (3) `addCustom` never fails silently on a bad
 * value (it toasts) and never POSTs garbage to the worker.
 */
describe('AdminDomainsComponent (add-domain validation + feedback)', () => {
  function make(input = ''): { c: AdminDomainsComponent; post: jasmine.Spy; toastErr: jasmine.Spy } {
    TestBed.resetTestingModule(); // re-callable within a single test (multiple inputs)
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { hostname: 'x' } }));
    const toastErr = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post, put: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: toastErr, success: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    TestBed.overrideComponent(AdminDomainsComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminDomainsComponent).componentInstance;
    c.customDomainInput.set(input);
    return { c, post, toastErr };
  }
  const submit = (c: AdminDomainsComponent) => c.addCustom(new Event('submit'));

  afterEach(() => TestBed.resetTestingModule());

  it('customDomainInvalid is FALSE for empty input (no nagging before typing)', () => {
    expect(make('').c.customDomainInvalid()).toBeFalse();
    expect(make('   ').c.customDomainInvalid()).toBeFalse();
  });

  it('customDomainInvalid is TRUE for a non-empty malformed value', () => {
    expect(make('my site').c.customDomainInvalid()).toBeTrue();
    expect(make('examplecom').c.customDomainInvalid()).toBeTrue();
    expect(make('http://example.com').c.customDomainInvalid()).toBeTrue();
  });

  it('customDomainInvalid is FALSE for a valid FQDN', () => {
    expect(make('www.example.com').c.customDomainInvalid()).toBeFalse();
    expect(make('shop.acme.co.uk').c.customDomainInvalid()).toBeFalse();
  });

  it('addCustom on a malformed value TOASTS and does NOT POST (no silent dead-end, no garbage to the worker)', () => {
    const { c, post, toastErr } = make('not a domain');
    submit(c);
    expect(toastErr).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('addCustom on EMPTY input is a silent no-op (no toast, no POST)', () => {
    const { c, post, toastErr } = make('');
    submit(c);
    expect(toastErr).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('addCustom on a valid domain POSTs the hostname as a custom_cname', () => {
    const { c, post } = make('www.example.com');
    submit(c);
    expect(post).toHaveBeenCalledWith('/sites/s1/hostnames', { hostname: 'www.example.com', type: 'custom_cname' });
  });
});

/**
 * Render: the inline validation hint is visible ONLY for a non-empty malformed
 * value, the input is marked aria-invalid + described-by the hint, and a valid
 * value swaps back to the neutral CNAME helper text.
 */
describe('AdminDomainsComponent (add-domain inline hint render)', () => {
  function render(input: string): ComponentFixture<AdminDomainsComponent> {
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({}), put: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    const fx = TestBed.createComponent(AdminDomainsComponent);
    fx.componentInstance.customDomainInput.set(input);
    fx.detectChanges();
    return fx;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('shows the inline hint + marks the input aria-invalid for a malformed value', () => {
    const el: HTMLElement = render('bad value').nativeElement;
    expect(el.querySelector('[data-testid="custom-domain-hint"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="custom-domain-input"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('hides the hint (neutral helper shown, input not aria-invalid) for empty + valid input', () => {
    for (const v of ['', 'www.example.com']) {
      const el: HTMLElement = render(v).nativeElement;
      expect(el.querySelector('[data-testid="custom-domain-hint"]')).withContext(`hint hidden for "${v}"`).toBeNull();
      expect(el.querySelector('[data-testid="custom-domain-input"]')?.getAttribute('aria-invalid')).not.toBe('true');
      TestBed.resetTestingModule();
    }
  });
});

/**
 * WCAG 1.3.1 / 4.1.2 — the add-custom-domain + AI-search inputs had VISIBLE
 * labels ("Already own a domain?" / "Search creative domains with AI") that
 * were not programmatically associated (no for/id), so a screen reader didn't
 * announce the input's purpose. Associate label[for] ↔ input[id].
 */
describe('AdminDomainsComponent (input label association)', () => {
  let fixture: ComponentFixture<AdminDomainsComponent>;
  function build(): void {
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({ data: {} }), put: () => of({ data: {} }), delete: () => of({ data: {} }) } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    fixture = TestBed.createComponent(AdminDomainsComponent);
    fixture.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('associates the custom-domain input with its visible label', () => {
    build();
    const el: HTMLElement = fixture.nativeElement;
    const input = el.querySelector('input[name="customDomain"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.id).withContext('input has an id').toBeTruthy();
    expect(el.querySelector(`label[for="${input.id}"]`)).withContext('a label[for] points to it').toBeTruthy();
  });

  it('associates the AI domain-search input with its visible label', () => {
    build();
    const el: HTMLElement = fixture.nativeElement;
    const input = el.querySelector('input[placeholder^="e.g. premium"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.id).toBeTruthy();
    expect(el.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
  });
});

/**
 * Double-toast guard: each Domains mutation surfaces its OWN specific toast.error
 * in the error branch, so the ApiService call must be {silent:true} — else the
 * generic "Can't reach the server" toast double-fires on failure.
 */
describe('AdminDomainsComponent — mutations pass {silent:true} (no generic double-toast)', () => {
  let put: jasmine.Spy, del: jasmine.Spy, post: jasmine.Spy;

  function buildSpies(): AdminDomainsComponent {
    put = jasmine.createSpy('put').and.returnValue(of({ data: {} }));
    del = jasmine.createSpy('delete').and.returnValue(of({ data: {} }));
    post = jasmine.createSpy('post').and.returnValue(of({ data: { results: [] } }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post, put, delete: del } },
        { provide: ToastService, useValue: { success: () => 0, error: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    return TestBed.createComponent(AdminDomainsComponent).componentInstance;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('makePrimary → put is {silent}', () => {
    const c = buildSpies();
    c.makePrimary({ id: 'h9', is_primary: 0 } as never);
    expect(put).toHaveBeenCalledWith('/sites/s1/hostnames/h9/primary', undefined, { silent: true });
  });

  it('removeHostname → delete is {silent} (after confirm)', async () => {
    const c = buildSpies();
    await c.removeHostname({ id: 'h9', hostname: 'x.com' } as never);
    expect(del).toHaveBeenCalledWith('/sites/s1/hostnames/h9', { silent: true });
  });

  it('runAiSearch → ai-search post is {silent}', () => {
    const c = buildSpies();
    c.aiQuery.set('coffee shop');
    c.runAiSearch();
    expect(post).toHaveBeenCalledWith('/sites/s1/domains/ai-search', { query: 'coffee shop' }, { silent: true });
  });
});

describe('AdminDomainsComponent (register domain — confirm before the recurring charge)', () => {
  function make(confirmResult: boolean): { c: AdminDomainsComponent; post: jasmine.Spy; confirmSpy: jasmine.Spy } {
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { domain: 'x.com', status: 'pending' } }));
    const confirmSpy = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post, put: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: confirmSpy } },
      ],
    });
    TestBed.overrideComponent(AdminDomainsComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminDomainsComponent).componentInstance, post, confirmSpy };
  }
  afterEach(() => TestBed.resetTestingModule());

  const card = { name: 'getvito.com', tld: 'com', price_usd: 12.99, available: true, strategy: 'exact' } as never;

  it('confirms with danger:true (showing the price) then POSTs the registration', async () => {
    const { c, post, confirmSpy } = make(true);
    await c.registerDomain(card);
    expect(confirmSpy).toHaveBeenCalled();
    const arg = confirmSpy.calls.mostRecent().args[0] as { danger?: boolean; message?: string };
    expect(arg.danger).toBeTrue();
    expect(arg.message).toContain('$12.99');
    expect(post).toHaveBeenCalledWith('/sites/s1/domains/register', { domain: 'getvito.com' });
  });

  it('does NOT POST (no charge) when the confirm is cancelled', async () => {
    const { c, post, confirmSpy } = make(false);
    await c.registerDomain(card);
    expect(confirmSpy).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('AdminDomainsComponent (AI domain search — gate on a real query)', () => {
  function make(): { c: AdminDomainsComponent; post: jasmine.Spy } {
    TestBed.resetTestingModule();
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { available: [], unavailable: [] } }));
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'vito' }) } },
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post, put: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    TestBed.overrideComponent(AdminDomainsComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminDomainsComponent).componentInstance, post };
  }

  it('aiQueryValid requires ≥2 non-blank chars (gates the button)', () => {
    const { c } = make();
    c.aiQuery.set('');
    expect(c.aiQueryValid()).toBeFalse();
    c.aiQuery.set('   ');
    expect(c.aiQueryValid()).toBeFalse();
    c.aiQuery.set('a');
    expect(c.aiQueryValid()).toBeFalse();
    c.aiQuery.set('barber shop');
    expect(c.aiQueryValid()).toBeTrue();
  });

  it('runAiSearch does NOT fire the LLM fan-out on a blank query (no wasted model call)', () => {
    const { c, post } = make();
    c.aiQuery.set('   ');
    c.runAiSearch();
    expect(post).not.toHaveBeenCalled();
    expect(c.aiSearching()).toBeFalse();
  });

  it('runAiSearch fires the search for a real query', () => {
    const { c, post } = make();
    c.aiQuery.set('premium barber shop in Newark');
    c.runAiSearch();
    expect(post).toHaveBeenCalledWith(
      '/sites/s1/domains/ai-search',
      { query: 'premium barber shop in Newark' },
      { silent: true },
    );
  });
});

/**
 * Real-time doctrine (fire-59): the Domains surface self-updates — NO manual
 * "Refresh" button anywhere. The hostname list background-polls on a
 * visibility-aware interval (paused while `document.hidden`, immediate silent
 * catch-up on foreground return) and refreshes after every mutation. A quiet
 * "synced" hint replaces the old button — informational text, zero chrome.
 */
describe('AdminDomainsComponent (real-time: no manual refresh + visibility-aware poll)', () => {
  let fixture: ComponentFixture<AdminDomainsComponent>;
  let selectedSite: WritableSignal<{ id: string; slug: string } | null>;
  let getSpy: jasmine.Spy;

  function build(initial: { id: string; slug: string } | null): void {
    selectedSite = signal(initial);
    getSpy = jasmine.createSpy('get').and.callFake(() => of({ data: [] }));
    const api = {
      get: getSpy,
      post: () => of({ data: {} }),
      put: () => of({ data: {} }),
      delete: () => of({ data: {} }),
    };
    TestBed.configureTestingModule({
      imports: [AdminDomainsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite } },
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: { success: () => undefined, error: () => undefined } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
      ],
    });
    fixture = TestBed.createComponent(AdminDomainsComponent);
    fixture.detectChanges();
  }

  beforeEach(() => jasmine.clock().install());
  afterEach(() => {
    jasmine.clock().uninstall();
    TestBed.resetTestingModule();
  });

  it('renders NO manual Refresh button (real-time-no-manual-refresh doctrine)', () => {
    build({ id: 's1', slug: 'vito' });
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    const refreshButtons = buttons.filter((b) => /refresh/i.test(b.textContent ?? ''));
    expect(refreshButtons.length)
      .withContext('a manual Refresh control violates the real-time doctrine')
      .toBe(0);
  });

  it('background-polls the hostname list on the poll interval while visible', () => {
    build({ id: 's1', slug: 'vito' });
    const initial = getSpy.calls.count();
    jasmine.clock().tick(45_001);
    expect(getSpy.calls.count()).withContext('first poll tick').toBe(initial + 1);
    jasmine.clock().tick(45_001);
    expect(getSpy.calls.count()).withContext('second poll tick').toBe(initial + 2);
  });

  it('pauses the poll while hidden and silently catches up on foreground return', () => {
    build({ id: 's1', slug: 'vito' });
    const c = fixture.componentInstance as unknown as { isHidden(): boolean };
    const hiddenSpy = spyOn(c, 'isHidden').and.returnValue(true);
    const initial = getSpy.calls.count();
    jasmine.clock().tick(45_001);
    expect(getSpy.calls.count()).withContext('no fetch while hidden').toBe(initial);
    hiddenSpy.and.returnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(getSpy.calls.count()).withContext('immediate catch-up on return').toBe(initial + 1);
    // The catch-up is a BACKGROUND refresh — it must not flash the loading skeleton.
    expect(fixture.componentInstance.loadingHostnames()).toBeFalse();
  });

  it('shows the quiet synced hint instead of a button after data lands', () => {
    build({ id: 's1', slug: 'vito' });
    fixture.detectChanges();
    const hint = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="domains-synced-hint"]',
    );
    expect(hint).withContext('quiet auto-update hint replaces the Refresh button').not.toBeNull();
    expect(hint!.textContent).toContain('synced');
  });

  it('stops polling after destroy (no timer leak)', () => {
    build({ id: 's1', slug: 'vito' });
    const afterInit = getSpy.calls.count();
    fixture.destroy();
    jasmine.clock().tick(140_000);
    expect(getSpy.calls.count()).withContext('destroyed component must not fetch').toBe(afterInit);
  });
});
