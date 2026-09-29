import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminWebhooksComponent } from './webhooks.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AdminStateService } from '../admin-state.service';

/**
 * Guards the Outbound Webhooks (#10) admin section: empty state w/o site, list
 * renders, create posts {url, eventTypes} + reveals the secret once, delete
 * calls the API + reloads.
 */
describe('AdminWebhooksComponent', () => {
  let fixture: ComponentFixture<AdminWebhooksComponent>;
  let host: HTMLElement;
  let get: jasmine.Spy;
  let post: jasmine.Spy;
  let del: jasmine.Spy;
  let confirmSpy: jasmine.Spy;

  function build(site: { id: string } | null, confirmResult = true): void {
    get = jasmine.createSpy('get').and.callFake((path: string) =>
      path.endsWith('/deliveries')
        ? of({ ok: true, deliveries: [{ id: 'd1', eventType: 'site.published', statusCode: 200, ok: true, attempt: 1, createdAt: '2026-06-02T00:00:00Z' }] })
        : of({ ok: true, endpoints: [{ id: 'e1', url: 'https://x.com/h', eventTypes: ['site.published'], enabled: true }] }),
    );
    post = jasmine.createSpy('post').and.returnValue(of({ ok: true, id: 'e2', secret: 'whsec_topsecret' }));
    del = jasmine.createSpy('delete').and.returnValue(of({ ok: true }));
    confirmSpy = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get, post, delete: del } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
        { provide: ConfirmService, useValue: { confirm: confirmSpy } },
        { provide: AdminStateService, useValue: { selectedSite: () => site } },
      ],
    });
    fixture = TestBed.createComponent(AdminWebhooksComponent);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  const q = (sel: string): HTMLElement | null => host.querySelector(sel);
  const all = (sel: string): HTMLElement[] => Array.from(host.querySelectorAll(sel));
  afterEach(() => TestBed.resetTestingModule());

  it('a 404 (outbound_webhooks flag OFF) shows the calm cyan Feature-Flags gate, not a red error card', () => {
    const g = jasmine.createSpy('get').and.callFake((path: string) =>
      path.endsWith('/deliveries')
        ? of({ ok: true, deliveries: [] })
        : throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })),
    );
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: g, post: jasmine.createSpy('post'), delete: jasmine.createSpy('delete') } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
        { provide: ConfirmService, useValue: { confirm: jasmine.createSpy('confirm') } },
        { provide: AdminStateService, useValue: { selectedSite: () => ({ id: 'site-1' }) } },
      ],
    });
    const fx = TestBed.createComponent(AdminWebhooksComponent);
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(fx.componentInstance.flagDisabled()).withContext('404 → flag-disabled').toBeTrue();
    const gate = el.querySelector('[data-testid="webhooks-flag-gate"]');
    expect(gate).withContext('calm cyan gate notice renders').toBeTruthy();
    expect(el.querySelector('[data-testid="webhooks-error"]')).withContext('no red error card on a permanent gate').toBeNull();
    expect((gate?.querySelector('a') as HTMLAnchorElement | null)?.getAttribute('href')).toBe('/admin/feature-flags');
  });

  it('flag OFF → gate notice renders ABOVE a dimmed, fully-disabled create form (matches the recipes gold-standard, not a live-looking form over a disabled notice)', async () => {
    const g = jasmine.createSpy('get').and.callFake((path: string) =>
      path.endsWith('/deliveries')
        ? of({ ok: true, deliveries: [] })
        : throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })),
    );
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: g, post: jasmine.createSpy('post'), delete: jasmine.createSpy('delete') } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
        { provide: ConfirmService, useValue: { confirm: jasmine.createSpy('confirm') } },
        { provide: AdminStateService, useValue: { selectedSite: () => ({ id: 'site-1' }) } },
      ],
    });
    const fx = TestBed.createComponent(AdminWebhooksComponent);
    fx.detectChanges();
    // ngModel propagates [disabled] in a microtask — let it settle before reading native .disabled.
    await fx.whenStable();
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    expect(fx.componentInstance.flagDisabled()).toBeTrue();

    const gate = el.querySelector('[data-testid="webhooks-flag-gate"]')!;
    const urlInput = el.querySelector('[data-testid="webhooks-url"]') as HTMLInputElement;
    expect(gate).withContext('gate notice present').toBeTruthy();
    expect(urlInput).withContext('create form still rendered (as a disabled preview)').toBeTruthy();

    // (1) Notice precedes the form in DOM order — the user learns it's disabled FIRST.
    const order = gate.compareDocumentPosition(urlInput);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING)
      .withContext('flag-gate notice must render ABOVE the create form, not below it').toBeTruthy();

    // (2) Every input is disabled — not just the submit button (no interactive form over a disabled feature).
    expect(urlInput.disabled).withContext('URL input disabled when flag off').toBeTrue();
    const firstCheckbox = el.querySelector('[data-testid^="webhooks-event-"]') as HTMLInputElement;
    expect(firstCheckbox?.disabled).withContext('event checkboxes disabled when flag off').toBeTrue();
    const addBtn = el.querySelector('[data-testid="webhooks-create-btn"]') as HTMLButtonElement;
    expect(addBtn.disabled).withContext('Add endpoint disabled when flag off').toBeTrue();

    // (3) The form is visibly dimmed so it reads as a disabled preview.
    const formWrap = urlInput.closest('.opacity-60');
    expect(formWrap).withContext('create form wrapper is dimmed (opacity-60) when flag off').toBeTruthy();
  });

  it('shows the empty state with no selected site', () => {
    build(null);
    expect(q('[data-testid="webhooks-empty"]')).not.toBeNull();
    expect(q('[data-testid="webhooks-create-btn"]')).toBeNull();
  });

  // The "No webhook endpoints" empty state must render its guidance line. The
  // kit <app-empty-state> input is `message=`, NOT `body=` — passing `body=`
  // silently drops the supporting text (the @if(message) never fires).
  it('the no-endpoints empty state renders its guidance message (kit input is message=)', () => {
    const g = jasmine.createSpy('get').and.callFake((path: string) =>
      path.endsWith('/deliveries') ? of({ ok: true, deliveries: [] }) : of({ ok: true, endpoints: [] }),
    );
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: g, post: jasmine.createSpy('post'), delete: jasmine.createSpy('delete') } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
        { provide: ConfirmService, useValue: { confirm: jasmine.createSpy('confirm') } },
        { provide: AdminStateService, useValue: { selectedSite: () => ({ id: 's1' }) } },
      ],
    });
    const fx = TestBed.createComponent(AdminWebhooksComponent);
    fx.detectChanges();
    const msg = (fx.nativeElement as HTMLElement).querySelector('app-empty-state .es-msg');
    expect(msg).withContext('supporting message paragraph renders').not.toBeNull();
    expect(msg?.textContent).toContain('signed event callbacks');
    // First-result-action launchpad: the empty state offers the create CTA, not just prose.
    const cta = (fx.nativeElement as HTMLElement).querySelector('app-empty-state [data-testid="empty-cta"]');
    expect(cta).withContext('empty-state launchpad CTA renders').not.toBeNull();
    expect(cta?.textContent).toContain('Add your first endpoint');
  });

  it('lists the site endpoints + recent deliveries', () => {
    build({ id: 's1' });
    expect(get).toHaveBeenCalledWith('/sites/s1/webhooks', undefined, { silent: true });
    expect(get).toHaveBeenCalledWith('/sites/s1/webhooks/deliveries', undefined, { silent: true });
    expect(all('[data-testid="webhooks-row"]').length).toBe(1);
    expect(all('[data-testid="webhooks-delivery-row"]').length).toBe(1);
  });

  it('creates an endpoint and reveals the secret once', () => {
    build({ id: 's1' });
    fixture.componentInstance.urlModel.set('https://hooks.me/x');
    fixture.detectChanges(); // let the canSubmit()-gated button enable before clicking
    (q('[data-testid="webhooks-create-btn"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(post).toHaveBeenCalledWith('/sites/s1/webhooks', { url: 'https://hooks.me/x', eventTypes: ['site.published'] });
    expect(q('[data-testid="webhooks-secret"]')?.textContent).toContain('whsec_topsecret');
  });

  // The signing secret is shown ONCE + 'won't be shown again' — manually selecting
  // a break-all <code> block to copy an unrecoverable secret is error-prone. A
  // Copy button must exist + copy the exact secret to the clipboard.
  it('reveals a Copy button for the one-time secret + copies the exact value', async () => {
    build({ id: 's1' });
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fixture.componentInstance.createdSecret.set('whsec_topsecret');
    fixture.detectChanges();

    const copyBtn = q('[data-testid="webhooks-secret-copy"]') as HTMLButtonElement | null;
    expect(copyBtn).withContext('a one-time secret must have a Copy affordance').not.toBeNull();
    await fixture.componentInstance.copySecret();
    expect(writeText).toHaveBeenCalledWith('whsec_topsecret');
    expect(fixture.componentInstance.secretCopied()).toBeTrue();
    // One-time-secret hygiene: after a successful copy the secret is dropped from
    // component state (contract: "copy it now, it won't be shown again") so it can
    // never linger in the DOM. The banner disappears on the next change detection.
    expect(fixture.componentInstance.createdSecret()).withContext('secret cleared after copy').toBeNull();
    fixture.detectChanges();
    expect(q('[data-testid="webhooks-secret"]')).withContext('secret banner gone after copy').toBeNull();
  });

  // Cross-site secret leak: switching the selected site must wipe any lingering
  // one-time secret from the prior site — otherwise navigating away + back exposes
  // site A's secret under site B's header. Mirrors deliverability.component.
  it('clears a lingering one-time secret when the selected site changes', () => {
    const siteSig = signal<{ id: string } | null>({ id: 's1' });
    const g = jasmine.createSpy('get').and.callFake((p: string) =>
      p.endsWith('/deliveries') ? of({ ok: true, deliveries: [] }) : of({ ok: true, endpoints: [] }),
    );
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: g, post: jasmine.createSpy('post'), delete: jasmine.createSpy('delete') } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('e'), success: jasmine.createSpy('s') } },
        { provide: ConfirmService, useValue: { confirm: jasmine.createSpy('confirm') } },
        { provide: AdminStateService, useValue: { selectedSite: siteSig } },
      ],
    });
    const fx = TestBed.createComponent(AdminWebhooksComponent);
    fx.detectChanges();
    // Simulate a just-created endpoint leaving its one-time secret in state.
    fx.componentInstance.createdSecret.set('whsec_leaked');
    fx.detectChanges();
    expect(fx.componentInstance.createdSecret()).toBe('whsec_leaked');

    siteSig.set({ id: 's2' }); // operator switches sites
    fx.detectChanges();
    expect(fx.componentInstance.createdSecret()).withContext('secret wiped on site change').toBeNull();
  });

  it('toggles event selection', () => {
    build({ id: 's1' });
    const c = fixture.componentInstance;
    expect(c.selected()).toEqual(['site.published']);
    c.toggleEvent('form.submitted');
    expect(c.selected()).toContain('form.submitted');
    c.toggleEvent('site.published');
    expect(c.selected()).not.toContain('site.published');
  });

  // Copy polish: the selected-count pluralizes properly — "1 event selected"
  // (singular), "2 events selected" (plural) — never the lazy "1 event(s) selected".
  it('pluralizes the selected-event count correctly (singular vs plural, no "(s)")', () => {
    build({ id: 's1' }); // default selection = ['site.published'] → exactly 1
    const label = () => q('[data-testid="webhooks-selected-count"]')?.textContent?.trim() ?? '';
    expect(label()).toBe('1 event selected');
    expect(label()).not.toContain('(s)');
    fixture.componentInstance.toggleEvent('form.submitted'); // → 2 selected
    fixture.detectChanges();
    expect(label()).toBe('2 events selected');
  });

  it('deletes an endpoint after confirmation and reloads', async () => {
    build({ id: 's1' }); // confirm resolves true
    const before = get.calls.count();
    await fixture.componentInstance.remove('e1', 'https://x.com/h');
    expect(confirmSpy).toHaveBeenCalled(); // destructive action is confirmed first
    expect(del).toHaveBeenCalledWith('/sites/s1/webhooks/e1', { silent: true }); // {silent}: own error toast, no generic double-toast
    expect(get.calls.count()).toBeGreaterThan(before); // reloaded after delete
  });

  it('does NOT delete when the confirm is cancelled', async () => {
    build({ id: 's1' }, false); // confirm resolves false (operator cancels)
    await fixture.componentInstance.remove('e1', 'https://x.com/h');
    expect(confirmSpy).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('loads once the selected site resolves after mount (reactive, not just at construct)', () => {
    const siteSig = signal<{ id: string } | null>(null);
    const g = jasmine.createSpy('get').and.callFake((p: string) =>
      p.endsWith('/deliveries') ? of({ ok: true, deliveries: [] }) : of({ ok: true, endpoints: [] }),
    );
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: g, post: jasmine.createSpy('post'), delete: jasmine.createSpy('delete') } },
        { provide: ToastService, useValue: { error: jasmine.createSpy('e'), success: jasmine.createSpy('s') } },
        { provide: AdminStateService, useValue: { selectedSite: siteSig } },
      ],
    });
    const fx = TestBed.createComponent(AdminWebhooksComponent);
    fx.detectChanges();
    expect(g).not.toHaveBeenCalled(); // no site yet

    siteSig.set({ id: 's9' });
    fx.detectChanges();
    expect(g).toHaveBeenCalledWith('/sites/s9/webhooks', undefined, { silent: true });
  });

  it('surfaces a not-available error', () => {
    build({ id: 's1' });
    get.and.returnValue(throwError(() => ({ error: {} })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(q('[data-testid="webhooks-error"]')).not.toBeNull();
  });

  it('a transient 500 → retryable error rendered via the gold-standard error card + Retry', () => {
    build({ id: 's1' });
    get.and.returnValue(throwError(() => ({ status: 500 })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(fixture.componentInstance.errorRetryable()).toBeTrue();
    // The transient failure now uses the shared <app-error-card> (Retry + a
    // copyable support reference) instead of a bare banner.
    expect(q('app-error-card')).withContext('shared error-card primitive').not.toBeNull();
    expect(q('[data-testid="error-retry"]')).withContext('Retry on the card').not.toBeNull();
  });

  it('surfaces the worker request_id as a copyable support reference on a transient failure', () => {
    build({ id: 's1' });
    get.and.returnValue(throwError(() => ({ status: 500, error: { error: { request_id: 'req_abc123' } } })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(fixture.componentInstance.loadErrorRef()).toBe('req_abc123');
    expect(q('[data-testid="error-correlation"]')?.textContent).withContext('reference shown for support').toContain('req_abc123');
  });

  it('a 404 (flag OFF) → calm cyan flag-gate, NOT a red error card (retrying cannot help)', () => {
    build({ id: 's1' });
    get.and.returnValue(throwError(() => ({ status: 404 })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(fixture.componentInstance.flagDisabled()).withContext('404 → flag-disabled').toBeTrue();
    expect(fixture.componentInstance.error()).withContext('gate is not a red error').toBeNull();
    expect(q('[data-testid="webhooks-flag-gate"]')).withContext('calm cyan gate renders').not.toBeNull();
    expect(q('[data-testid="webhooks-error"]')).withContext('no red error card / Retry on a permanent gate').toBeNull();
  });

  it('a load error SUPPRESSES the empty state (no error + "No webhook endpoints" shown together)', () => {
    build({ id: 's1' });
    get.and.returnValue(throwError(() => ({ status: 500 })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(q('[data-testid="webhooks-error"]')).not.toBeNull();
    expect(q('app-empty-state')).withContext('the error owns the display — no double "No endpoints"').toBeNull();
  });

  // ── Stale-route fake-empty guard (reliability) ────────────────────────────
  // A STALE worker route can return 200 + a body that PARSES as JSON but is the
  // wrong shape (e.g. `{}` from a misroute, or an SPA-fallthrough that happens
  // to parse). `res.endpoints ?? []` only guards null/undefined → a shapeless
  // 200 becomes a misleading "No webhook endpoints" masking a broken route, or
  // (non-array `endpoints`) crashes the @for. Guard with Array.isArray → honest
  // retryable error, never fake-empty/crash. (Mirrors site-features.enterFallbackMode.)
  it('a stale 200 with NO endpoints array shows an honest error, NOT a fake-empty list', () => {
    build({ id: 's1' });
    get.and.callFake((path: string) =>
      path.endsWith('/deliveries') ? of({ ok: true, deliveries: [] }) : of({} as { ok: boolean; endpoints: never[] }),
    );
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(fixture.componentInstance.endpoints()).withContext('no fake-empty population').toEqual([]);
    expect(fixture.componentInstance.error()).withContext('shapeless 200 → honest error').not.toBeNull();
    expect(fixture.componentInstance.errorRetryable()).toBeTrue();
    expect(q('[data-testid="webhooks-error"]')).withContext('retryable error card').not.toBeNull();
    expect(q('app-empty-state')).withContext('no misleading "No endpoints" over a broken route').toBeNull();
  });

  it('a stale 200 with a non-array endpoints value degrades to an error (no @for crash)', () => {
    build({ id: 's1' });
    get.and.callFake((path: string) =>
      path.endsWith('/deliveries')
        ? of({ ok: true, deliveries: [] })
        : of({ ok: true, endpoints: '<!doctype html>' } as unknown as { ok: boolean; endpoints: never[] }),
    );
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(fixture.componentInstance.endpoints()).withContext('never set to a non-array').toEqual([]);
    expect(fixture.componentInstance.error()).withContext('non-array shape → honest error').not.toBeNull();
  });

  it('a stale 200 with a non-array deliveries value stays empty (best-effort, no @for crash)', () => {
    build({ id: 's1' });
    get.and.callFake((path: string) =>
      path.endsWith('/deliveries')
        ? of({ ok: true, deliveries: '<!doctype html>' } as unknown as { ok: boolean; deliveries: never[] })
        : of({ ok: true, endpoints: [] }),
    );
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(fixture.componentInstance.deliveries()).withContext('non-array deliveries → empty, never crashes the @for').toEqual([]);
  });

  // ── Failed-delivery reason surfacing (visible operator improvement) ────────
  // The deliveries endpoint already exposes a per-attempt `error` string. A
  // failed row showed only "500 fail" with no reason — surface the worker's own
  // failure text as an accessible tooltip so operators can debug (timeout / 401
  // / DNS) without a separate fetch. (No secret involved — it's the delivery error.)
  it('a failed delivery surfaces its error reason as an accessible title', () => {
    build({ id: 's1' });
    get.and.callFake((path: string) =>
      path.endsWith('/deliveries')
        ? of({ ok: true, deliveries: [{ id: 'd9', eventType: 'form.submitted', statusCode: 0, ok: false, attempt: 3, error: 'Connection timeout after 10s', createdAt: '2026-06-02T00:00:00Z' }] })
        : of({ ok: true, endpoints: [] }),
    );
    fixture.componentInstance.load();
    fixture.detectChanges();
    const row = q('[data-testid="webhooks-delivery-row"]');
    expect(row).not.toBeNull();
    const status = row?.querySelector('[data-testid="webhooks-delivery-status"]') as HTMLElement | null;
    expect(status?.getAttribute('title')).withContext('failure reason shown on hover').toContain('Connection timeout after 10s');
  });

  // ── Create input validation (security/reliability) ────────────────────────
  // A webhook endpoint is called server-side, so a junk / http / internal URL
  // is an SSRF-adjacent footgun. Bad input must be rejected client-side with a
  // useful toast and NEVER reach the API; a valid https URL submits once.
  const toastErrSpy = (): jasmine.Spy => TestBed.inject(ToastService).error as jasmine.Spy;

  it('rejects a non-URL string — toasts an error and does NOT POST', () => {
    build({ id: 's1' });
    fixture.componentInstance.urlModel.set('notaurl');
    fixture.componentInstance.create();
    expect(post).not.toHaveBeenCalled();
    expect(toastErrSpy()).toHaveBeenCalled();
  });

  it('rejects a non-https (http://) URL — webhook targets must be https', () => {
    build({ id: 's1' });
    fixture.componentInstance.urlModel.set('http://hooks.example.com/x');
    fixture.componentInstance.create();
    expect(post).not.toHaveBeenCalled();
    expect(toastErrSpy()).toHaveBeenCalled();
  });

  it('rejects a hostname with no dot (e.g. https://localhost — internal target)', () => {
    build({ id: 's1' });
    fixture.componentInstance.urlModel.set('https://localhost');
    fixture.componentInstance.create();
    expect(post).not.toHaveBeenCalled();
    expect(toastErrSpy()).toHaveBeenCalled();
  });

  it('rejects when no events are selected', () => {
    build({ id: 's1' });
    fixture.componentInstance.urlModel.set('https://hooks.yourapp.com/projectsites');
    fixture.componentInstance.selected.set([]);
    fixture.componentInstance.create();
    expect(post).not.toHaveBeenCalled();
    expect(toastErrSpy()).toHaveBeenCalled();
  });

  it('accepts a well-formed https URL — POSTs exactly once with the trimmed URL', () => {
    build({ id: 's1' });
    fixture.componentInstance.urlModel.set('  https://hooks.yourapp.com/projectsites  ');
    fixture.componentInstance.selected.set(['site.published']);
    fixture.componentInstance.create();
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.calls.mostRecent().args as [string, { url: string; eventTypes: string[] }];
    expect(url).toBe('/sites/s1/webhooks');
    expect(body.url).toBe('https://hooks.yourapp.com/projectsites'); // trimmed
  });

  it('canSubmit() gates the button — false for a bad URL, true for a valid one', () => {
    build({ id: 's1' });
    const c = fixture.componentInstance;
    c.selected.set(['site.published']);
    c.urlModel.set('ftp://x');
    expect(c.canSubmit()).toBe(false);
    c.urlModel.set('https://hooks.yourapp.com/x');
    expect(c.canSubmit()).toBe(true);
    c.selected.set([]); // valid URL but no events
    expect(c.canSubmit()).toBe(false);
  });

  it('urlInvalid() is true only for a non-empty value that is not a valid https URL', () => {
    build({ id: 's1' });
    const c = fixture.componentInstance;
    c.urlModel.set('');
    expect(c.urlInvalid()).toBe(false); // empty → incomplete, not "invalid"
    c.urlModel.set('http://x');
    expect(c.urlInvalid()).toBe(true);
    c.urlModel.set('https://hooks.yourapp.com/x');
    expect(c.urlInvalid()).toBe(false);
  });

  it('renders the event checkboxes through Spartan hlmCheckbox (cyan accent + focus ring)', () => {
    build({ id: 's1' });
    const boxes = all('input[type=checkbox][hlmCheckbox]');
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => !b.className.includes('accent-primary'))).toBeTrue();
  });

  it('while loading, shows the real surface and no bare "Loading…" text (skeleton removed)', () => {
    build({ id: 's1' });
    fixture.componentInstance.loading.set(true);
    fixture.detectChanges();
    // Skeleton primitive removed platform-wide — the real surface (the add-endpoint
    // form) renders directly during load; never a shimmer or bare "Loading…" text.
    expect(q('[data-testid="webhooks-create-btn"]')).withContext('real surface renders, not a shimmer').not.toBeNull();
    expect(q('app-skeleton')).withContext('the removed skeleton stays gone').toBeNull();
    expect(host.textContent ?? '').not.toContain('Loading endpoints…');
  });

  it('renders the rich app-empty-state (not bare text) when there are no endpoints', () => {
    build({ id: 's1' });
    fixture.componentInstance.endpoints.set([]);
    fixture.detectChanges();
    expect(q('app-empty-state')).withContext('uses the reusable empty-state primitive').not.toBeNull();
  });
});

describe('AdminWebhooksComponent (public-host URL validation)', () => {
  let fx: import('@angular/core/testing').ComponentFixture<AdminWebhooksComponent>;
  afterEach(() => TestBed.resetTestingModule());

  function mk(): AdminWebhooksComponent {
    TestBed.configureTestingModule({
      imports: [AdminWebhooksComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ ok: true, endpoints: [] }), post: () => of({ ok: true }), delete: () => of({ ok: true }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: AdminStateService, useValue: { selectedSite: () => ({ id: 's1' }) } },
      ],
    });
    fx = TestBed.createComponent(AdminWebhooksComponent);
    fx.detectChanges();
    return fx.componentInstance;
  }

  it('flags private / link-local / metadata IP webhook URLs invalid (the "public hostname" promise)', () => {
    const c = mk();
    for (const url of [
      'https://127.0.0.1/h', 'https://10.0.0.1/h', 'https://192.168.0.1/h',
      'https://172.20.1.1/h', 'https://169.254.169.254/meta', 'https://api.internal/h',
    ]) {
      c.urlModel.set(url);
      expect(c.urlInvalid()).withContext(url).toBeTrue();
    }
    c.urlModel.set('https://hooks.example.com/projectsites');
    expect(c.urlInvalid()).withContext('public host valid').toBeFalse();
  });
});
