import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminDeliverabilityComponent } from './deliverability.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';

/**
 * Guards the Email Deliverability (#12) surface: empty state with no selected
 * site, Check calls GET /sites/:id/deliverability (+ optional domain), and the
 * report (score + SPF/DKIM/DMARC + fixes) renders. Locks the read-only contract.
 */
describe('AdminDeliverabilityComponent', () => {
  let fixture: ComponentFixture<AdminDeliverabilityComponent>;
  let host: HTMLElement;
  let get: jasmine.Spy;
  let selectedSite: () => { id: string; name: string; slug: string } | null;

  const REPORT = {
    ok: true,
    report: {
      domain: 'example.com',
      spf: { present: true, record: 'v=spf1 -all' },
      dmarc: { present: true, record: 'v=DMARC1; p=reject', policy: 'reject' },
      dkim: { present: false, selectorsChecked: ['google'], foundSelectors: [] },
      score: 70,
      recommendations: ['Publish a DKIM key.'],
    },
  };

  function build(site: { id: string; name: string; slug: string } | null): void {
    selectedSite = () => site;
    get = jasmine.createSpy('get').and.returnValue(of(REPORT));
    TestBed.configureTestingModule({
      imports: [AdminDeliverabilityComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
        { provide: AdminStateService, useValue: { selectedSite } },
      ],
    });
    fixture = TestBed.createComponent(AdminDeliverabilityComponent);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  const q = (sel: string): HTMLElement | null => host.querySelector(sel);
  const all = (sel: string): HTMLElement[] => Array.from(host.querySelectorAll(sel));

  afterEach(() => TestBed.resetTestingModule());

  it('shows the empty state when no site is selected', () => {
    build(null);
    expect(q('[data-testid="deliverability-empty"]')).not.toBeNull();
    expect(q('[data-testid="deliverability-check-btn"]')).toBeNull();
  });

  it('shows the idle preview rail (SPF/DKIM/DMARC "not checked yet") once a site is selected, before any check', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    const preview = q('[data-testid="deliverability-preview"]');
    expect(preview).withContext('idle preview rail fills the pre-check fold').not.toBeNull();
    // purely presentational — the real, announced result replaces it after a check
    expect(preview?.getAttribute('aria-hidden')).toBe('true');
    for (const rec of ['SPF', 'DKIM', 'DMARC']) expect(preview?.textContent).toContain(rec);
    expect(preview?.textContent).toContain('Not checked yet');
    expect(q('[data-testid="deliverability-result"]')).withContext('no result card before a check').toBeNull();
    expect(fixture.componentInstance.showPreview()).toBeTrue();
  });

  it('replaces the preview rail with the real result after a check', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    expect(q('[data-testid="deliverability-preview"]')).not.toBeNull();
    (q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(q('[data-testid="deliverability-preview"]')).withContext('preview hidden once a result exists').toBeNull();
    expect(q('[data-testid="deliverability-result"]')).not.toBeNull();
    expect(fixture.componentInstance.showPreview()).toBeFalse();
  });

  it('checks the selected site and renders the report', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    (q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.calls.mostRecent().args[0]).toBe('/sites/site1/deliverability');
    expect(q('[data-testid="deliverability-result"]')).not.toBeNull();
    expect(fixture.componentInstance.report()?.score).toBe(70);
    expect(all('[data-testid="deliverability-rec-row"]').length).toBe(1);
  });

  it('passes a domain override as a query param when set', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    fixture.componentInstance.domainModel.set('mail.acme.com');
    (q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    expect(get.calls.mostRecent().args[1]).toEqual({ domain: 'mail.acme.com' });
  });

  it('surfaces a 404 / not-available error gracefully', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    get.and.returnValue(throwError(() => ({ error: { error: { message: 'Not found' } } })));
    (q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(q('[data-testid="deliverability-error"]')).not.toBeNull();
  });

  it('a 404 (flag OFF) shows the calm cyan Feature-Flags gate, NOT a red error', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    get.and.returnValue(throwError(() => ({ status: 404 })));
    fixture.componentInstance.check();
    fixture.detectChanges();
    expect(fixture.componentInstance.flagDisabled()).withContext('404 → flag-disabled').toBeTrue();
    expect(fixture.componentInstance.error()).withContext('gate is not a red error').toBeNull();
    const gate = q('[data-testid="deliverability-flag-gate"]');
    expect(gate).withContext('calm cyan gate renders').not.toBeNull();
    expect(q('[data-testid="deliverability-error"]')).withContext('no red error card on a permanent gate').toBeNull();
    expect((gate?.querySelector('a') as HTMLAnchorElement | null)?.getAttribute('href')).toBe('/admin/feature-flags');
    // The Check button locks once gated (re-checking can't help until the flag is on).
    expect((q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).disabled).toBeTrue();
  });

  it('a 200 { needsDomain } (site has no sending domain) shows the calm neutral prompt, NOT a red error', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    get.and.returnValue(of({ ok: true, report: null, needsDomain: true }));
    fixture.componentInstance.check();
    fixture.detectChanges();
    expect(fixture.componentInstance.noDomain()).withContext('no sending domain → neutral state').toBeTrue();
    expect(fixture.componentInstance.error()).withContext('neutral prompt is not a red error').toBeNull();
    expect(q('[data-testid="deliverability-no-domain"]')).withContext('calm neutral prompt renders').not.toBeNull();
    expect(q('[data-testid="deliverability-error"]')).withContext('no red error card for a no-domain state').toBeNull();
    expect(q('[data-testid="deliverability-result"]')).withContext('no score card without a domain').toBeNull();
  });

  it('a legacy 400 (deploy-propagation window) degrades to the SAME calm neutral prompt, not a red error', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    get.and.returnValue(throwError(() => ({ status: 400, error: { error: { message: 'No sending domain to check' } } })));
    fixture.componentInstance.check();
    fixture.detectChanges();
    expect(fixture.componentInstance.noDomain()).withContext('400 → neutral (not red)').toBeTrue();
    expect(fixture.componentInstance.error()).withContext('no red error on the no-domain path').toBeNull();
    expect(q('[data-testid="deliverability-no-domain"]')).not.toBeNull();
    expect(q('[data-testid="deliverability-error"]')).toBeNull();
  });

  it('typing a domain after a no-domain prompt + a successful check clears the prompt and shows the result', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    get.and.returnValue(of({ ok: true, report: null, needsDomain: true }));
    fixture.componentInstance.check();
    fixture.detectChanges();
    expect(fixture.componentInstance.noDomain()).toBeTrue();
    // Operator types a real domain → the next check returns a report → prompt clears.
    get.and.returnValue(of(REPORT));
    fixture.componentInstance.domainModel.set('mail.acme.com');
    fixture.componentInstance.check();
    fixture.detectChanges();
    expect(fixture.componentInstance.noDomain()).withContext('neutral prompt cleared on a real result').toBeFalse();
    expect(q('[data-testid="deliverability-no-domain"]')).toBeNull();
    expect(q('[data-testid="deliverability-result"]')).not.toBeNull();
  });

  it('a transient failure (no server message) says "try again" — NOT a permanent "not available"', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    get.and.returnValue(throwError(() => ({ status: 500 })));
    fixture.componentInstance.check();
    const e = fixture.componentInstance.error() ?? '';
    expect(e).withContext('transient errors must invite a retry, not read as a permanent gate').toContain('try again');
    expect(e).not.toContain('not available for this site');
  });

  it('check() reads {silent:true} + on failure shows the inline banner ONLY (no own/generic double-toast)', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    const toastErr = TestBed.inject(ToastService).error as jasmine.Spy;
    get.and.returnValue(throwError(() => ({ status: 500 })));
    fixture.componentInstance.check();
    // silent so ApiService's generic toast can't fire…
    expect(get.calls.mostRecent().args[2]).toEqual({ silent: true });
    // …and the component no longer toasts on top of its own inline error banner.
    expect(fixture.componentInstance.error()).toBeTruthy();
    expect(toastErr).not.toHaveBeenCalled();
  });

  it('colors the score by band', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    const c = fixture.componentInstance;
    expect(c.scoreClass(90)).toBe('text-primary');
    expect(c.scoreClass(50)).toBe('text-amber-300');
    expect(c.scoreClass(10)).toBe('text-red-400');
  });

  it('renders the cyan score meter as an aria progressbar filled to the score', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    (q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const bar = q('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuenow')).toBe('70');
    const fill = q('[data-testid="deliverability-meter"]') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe('70%');
  });

  it('conveys record status with a symbol + text, not color alone (WCAG 1.4.1)', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    (q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    // SPF present → ✓ Configured; DKIM absent → ! Not found
    expect(q('[data-testid="deliverability-spf"]')?.textContent).toContain('✓');
    expect(q('[data-testid="deliverability-dkim"]')?.textContent).toContain('!');
    expect(q('[data-testid="deliverability-dkim"]')?.textContent).toContain('Not found');
  });

  it('associates the domain label with its input for screen readers', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    const input = q('[data-testid="deliverability-domain"]') as HTMLInputElement;
    expect(input.id).toBe('deliverability-domain');
    expect(q('label[for="deliverability-domain"]')).not.toBeNull();
  });

  // Client-side validation on the OPTIONAL domain override: junk gets instant
  // feedback instead of a DNS-lookup round-trip → server error.
  it('a malformed domain blocks the check (no GET) + shows the inline hint + gates the button', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    // fire-46 [S]: RFC-952 per-label — dash-only / dash-edged labels
    // (`mail.-.com`, `lead-.com`, `-lead.com`, `x.-y.com`) are now rejected
    // alongside the existing junk (scheme, spaces, single-label).
    for (const bad of ['https://example.com', 'example com', 'localhost', 'example', 'mail.-.com', 'lead-.com', '-lead.com', 'x.-y.com']) {
      get.calls.reset();
      fixture.componentInstance.domainModel.set(bad);
      fixture.detectChanges();
      expect(fixture.componentInstance.domainInvalid()).withContext(`invalid: ${bad}`).toBeTrue();
      expect((q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).disabled).withContext(`button gated: ${bad}`).toBeTrue();
      expect(q('[data-testid="deliverability-domain-hint"]')).withContext(`hint shown: ${bad}`).not.toBeNull();
      fixture.componentInstance.check();
      expect(get).withContext(`no DNS round-trip for junk: ${bad}`).not.toHaveBeenCalled();
    }
  });

  it('a valid bare domain (or empty) passes — domainInvalid false, GET fires', () => {
    build({ id: 'site1', name: 'Acme', slug: 'acme' });
    // fire-46 [S]: a valid RFC-952 hostname (incl. interior dashes + multi-label) passes.
    for (const good of ['mail.acme.com', 'a-b.example.com', 'sub.mail.example.co.uk', 'a--b.example.com']) {
      fixture.componentInstance.domainModel.set(good);
      fixture.detectChanges();
      expect(fixture.componentInstance.domainInvalid()).withContext(`valid: ${good}`).toBeFalse();
    }
    fixture.componentInstance.domainModel.set('mail.acme.com');
    fixture.detectChanges();
    expect((q('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).disabled).toBeFalse();
    fixture.componentInstance.check();
    expect(get).toHaveBeenCalled();
    // empty is valid too (uses the site's own domain)
    fixture.componentInstance.domainModel.set('');
    expect(fixture.componentInstance.domainInvalid()).toBeFalse();
  });
});

import { signal } from '@angular/core';

/**
 * Read-only result hygiene: the deliverability panel renders a report for the
 * site the operator checked. Switching sites must CLEAR that report (+ error /
 * domain override) so site A's score can never sit under site B's header — a
 * read-only stale-cross-site leak.
 */
describe('AdminDeliverabilityComponent (clears stale result on site switch)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const REPORT2 = {
    ok: true,
    report: {
      domain: 'a.com', spf: { present: true, record: 'x' },
      dmarc: { present: true, record: 'x', policy: 'reject' },
      dkim: { present: true, selectorsChecked: ['g'], foundSelectors: ['g'] },
      score: 88, recommendations: [],
    },
  };

  it('clears a prior report + domain override when the selected site changes', () => {
    const selectedSite = signal<{ id: string; slug: string } | null>({ id: 'site1', slug: 'a' });
    const get = jasmine.createSpy('get').and.returnValue(of(REPORT2));
    TestBed.configureTestingModule({
      imports: [AdminDeliverabilityComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite } },
      ],
    });
    const fixture = TestBed.createComponent(AdminDeliverabilityComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    c.domainModel.set('mail.a.com');
    c.check();
    fixture.detectChanges();
    expect(c.report()?.score).withContext('site1 report present').toBe(88);

    // Operator switches to a different site — the stale site1 report must clear.
    selectedSite.set({ id: 'site2', slug: 'b' });
    fixture.detectChanges();
    expect(c.report()).withContext('no stale cross-site report under the new site').toBeNull();
    expect(c.domainModel()).withContext('per-site override cleared').toBe('');
  });
});

/**
 * Network-failure honesty: a TRANSIENT failure on the live DNS check must read as
 * retryable via the gold-standard <app-error-card> — a real Retry that re-runs the
 * check (preserving the typed domain) AND a copyable worker request_id for support
 * hand-off. Parity with review-links / trust-center. A 404 stays the calm cyan
 * flag gate (retrying can't help). The worker envelope is
 * `{ error: { code, message, request_id } }`.
 */
describe('AdminDeliverabilityComponent (network-failure honesty)', () => {
  const OK = {
    ok: true,
    report: {
      domain: 'mail.acme.com', spf: { present: true, record: 'x' },
      dmarc: { present: false, record: null, policy: null },
      dkim: { present: true, selectorsChecked: ['g'], foundSelectors: ['g'] },
      score: 67, recommendations: ['Add a DMARC record.'],
    },
  };

  function buildErr(getSpy: jasmine.Spy): ComponentFixture<AdminDeliverabilityComponent> {
    TestBed.configureTestingModule({
      imports: [AdminDeliverabilityComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: getSpy } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal<{ id: string } | null>({ id: 's1' }) } },
      ],
    });
    const fx = TestBed.createComponent(AdminDeliverabilityComponent);
    fx.detectChanges();
    (fx.nativeElement.querySelector('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fx.detectChanges();
    return fx;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('a transient 500 → retryable failure rendered via the gold-standard error card + Retry', () => {
    const fx = buildErr(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))));
    const el = fx.nativeElement as HTMLElement;
    expect(fx.componentInstance.flagDisabled()).withContext('500 is not a flag gate').toBeFalse();
    expect(el.querySelector('app-error-card')).withContext('shared error-card primitive').not.toBeNull();
    expect(el.querySelector('[data-testid="error-retry"]')).withContext('Retry on the card').not.toBeNull();
  });

  it('surfaces the worker request_id as a copyable support reference on a transient failure', () => {
    const fx = buildErr(
      jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500, error: { error: { request_id: 'req_dl42' } } }))),
    );
    const el = fx.nativeElement as HTMLElement;
    expect(fx.componentInstance.loadErrorRef()).toBe('req_dl42');
    expect(el.querySelector('[data-testid="error-correlation"]')?.textContent).withContext('reference shown for support').toContain('req_dl42');
  });

  it('Retry re-runs the live DNS check (preserving the typed domain) + clears the error on success', () => {
    const get = jasmine.createSpy('get').and.returnValues(
      throwError(() => ({ status: 500, error: { error: { request_id: 'req_dl1' } } })),
      of(OK),
    );
    const fx = buildErr(get);
    fx.componentInstance.domainModel.set('mail.acme.com');
    expect(fx.componentInstance.error()).withContext('first attempt failed').not.toBeNull();

    (fx.nativeElement.querySelector('[data-testid="error-retry"]') as HTMLButtonElement).click();
    fx.detectChanges();

    expect(get).toHaveBeenCalledTimes(2);
    // The override domain is preserved across the retry (not lost) + stays {silent}.
    expect(get.calls.mostRecent().args).toEqual(['/sites/s1/deliverability', { domain: 'mail.acme.com' }, { silent: true }]);
    expect(fx.componentInstance.error()).withContext('error cleared on retry success').toBeNull();
    expect(fx.componentInstance.loadErrorRef()).withContext('reference cleared on success').toBe('');
    expect(fx.nativeElement.querySelector('[data-testid="deliverability-result"]')).not.toBeNull();
  });

  it('drops the stale report when a fresh check transiently fails (no score under an error)', () => {
    const get = jasmine.createSpy('get').and.returnValues(of(OK), throwError(() => ({ status: 500 })));
    const fx = buildErr(get); // first click (in buildErr) succeeded → report present
    expect(fx.componentInstance.report()).withContext('first check succeeded').not.toBeNull();

    (fx.nativeElement.querySelector('[data-testid="deliverability-check-btn"]') as HTMLButtonElement).click();
    fx.detectChanges();
    expect(fx.componentInstance.report()).withContext('stale report dropped on the failed re-check').toBeNull();
    expect(fx.nativeElement.querySelector('app-error-card')).not.toBeNull();
    expect(fx.nativeElement.querySelector('[data-testid="deliverability-result"]')).toBeNull();
  });
});
