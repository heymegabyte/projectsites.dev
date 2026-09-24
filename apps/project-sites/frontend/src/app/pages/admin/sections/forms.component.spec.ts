import { ComponentFixture, fakeAsync, flush, TestBed, tick } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AdminFormsComponent } from './forms.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';
import { provideRouter } from '@angular/router';

/**
 * Convergence r17 — cyan/black cohesion + a11y guard for the Forms section.
 *
 * Locks three contracts:
 *  1. Site-reactive load — on a deep-link the selected site resolves AFTER
 *     mount, so the constructor effect (not ngOnInit-once) must fire
 *     reload + loadSettings + loadMcp the instant selectedSite() resolves.
 *  2. The submissions count pill renders an <app-rolling-counter> (cinematic
 *     stat mandate) and the table rows are keyboard-openable (role=button +
 *     tabindex + keydown handler) for WCAG 2.1.1 / 2.4.7.
 *  3. Test-scenario pills + the manual-edit guard behave correctly.
 */
describe('AdminFormsComponent (cohesion + a11y, convergence r17)', () => {
  let fixture: ComponentFixture<AdminFormsComponent>;
  let component: AdminFormsComponent;
  let selectedSite: WritableSignal<{ id: string } | null>;
  let get: jasmine.Spy;
  let put: jasmine.Spy;

  function build(initial: { id: string } | null): void {
    try {
      localStorage.removeItem('ps_form_prompt_mcps');
      localStorage.removeItem('ps_forms_view');
    } catch {
      /* private mode — ignore */
    }
    selectedSite = signal<{ id: string } | null>(initial);
    get = jasmine.createSpy('get').and.callFake((url: string) => {
      if (url.includes('/ai-settings')) {
        return of({ data: { form_router_prompt: '', form_router_prompt_default: '', reply_email: '' } });
      }
      if (url.includes('/mcp/connections')) {
        return of({ data: { connections: [] } });
      }
      if (url.includes('/form-submissions')) {
        return of({ data: [] });
      }
      return of({ data: [] });
    });
    put = jasmine.createSpy('put').and.returnValue(of({}));
    TestBed.configureTestingModule({
      imports: [AdminFormsComponent],
      providers: [
        {
          provide: ApiService,
          useValue: {
            get,
            put,
            post: jasmine.createSpy('post').and.returnValue(of({ data: {} })),
          },
        },
        {
          provide: ToastService,
          useValue: {
            error: jasmine.createSpy('error'),
            success: jasmine.createSpy('success'),
          },
        },
        { provide: AdminStateService, useValue: { selectedSite } },
        // routerLinks in the template need ActivatedRoute (added by a later worktree); provide a no-op router.
        provideRouter([]),
      ],
    });
    fixture = TestBed.createComponent(AdminFormsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges(); // ngOnInit + first effect flush
  }

  afterEach(() => {
    fixture?.destroy(); // clears the auto-poll setInterval via ngOnDestroy
    TestBed.resetTestingModule();
  });

  // The worker caps the list at the 200 most-recent rows but returns the TRUE
  // total in `meta.total` (+ has_more) precisely so the count pill can't lie. A
  // site with >200 leads was showing "200 submissions" (under-reporting real,
  // revenue-bearing leads) because the FE read only `data` and ignored `meta`.
  it('count reflects the SERVER total (meta.total), not just the loaded page — no lying-count past the cap', () => {
    build(null);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      form_name: 'contact',
      email: `u${i}@x.com`,
      payload: '{}',
      status: 'received',
      created_at: '2026-08-01T00:00:00Z',
      fields: {},
    }));
    get.and.callFake((url: string) => {
      if (url.includes('/ai-settings')) {
        return of({ data: { form_router_prompt: '', form_router_prompt_default: '', reply_email: '' } });
      }
      if (url.includes('/mcp/connections')) {
        return of({ data: { connections: [] } });
      }
      if (url.includes('/form-submissions')) {
        return of({ data: rows, meta: { limit: 200, offset: 0, total: 250, has_more: true } });
      }
      return of({ data: [] });
    });
    selectedSite.set({ id: 'site-1' });
    fixture.detectChanges();

    expect(component.submissions().length).toBe(200); // the loaded page
    expect(component.totalCount()).toBe(250); // the TRUE lead count from meta
    expect(component.hasHiddenLeads()).toBe(true); // more leads exist than are shown
  });

  it('totalCount falls back to the loaded length when meta is absent (older worker / no cap)', () => {
    build(null);
    get.and.callFake((url: string) => {
      if (url.includes('/ai-settings')) {
        return of({ data: { form_router_prompt: '', form_router_prompt_default: '', reply_email: '' } });
      }
      if (url.includes('/mcp/connections')) {
        return of({ data: { connections: [] } });
      }
      if (url.includes('/form-submissions')) {
        return of({ data: [{ id: 'a', form_name: 'c', email: 'a@b.com', payload: '{}', status: 'received', created_at: '2026-08-01T00:00:00Z', fields: {} }] });
      }
      return of({ data: [] });
    });
    selectedSite.set({ id: 'site-1' });
    fixture.detectChanges();

    expect(component.totalCount()).toBe(1);
    expect(component.hasHiddenLeads()).toBe(false);
  });

  it('does NOT fetch anything on mount when no site is selected (deep-link)', () => {
    build(null);
    expect(get).not.toHaveBeenCalled();
  });

  // The test panel POSTs /v1/forms/submit, which resolves the site from ?slug= —
  // WITHOUT it the worker 400s "Missing X-Site-Slug" before validation (the panel
  // never worked). And form_name must be a slug (worker rejects a bad one → 400).
  it('runTest POSTs /v1/forms/submit?slug=<slug> — was 400 "Missing X-Site-Slug"', () => {
    build({ id: 'site-1', slug: 'megabytespace' } as never);
    const post = TestBed.inject(ApiService).post as jasmine.Spy;
    post.calls.reset();
    component.testInput.form_name = 'newsletter';
    component.testInput.fields_json = '{}';
    component.runTest();
    const call = post.calls.all().find((x) => String(x.args[0]).startsWith('/v1/forms/submit'));
    expect(call).withContext('runTest POSTs to the forms-submit endpoint').toBeTruthy();
    expect(String(call!.args[0])).withContext('carries ?slug= so the worker resolves the site').toContain('slug=megabytespace');
  });

  it('runTest BLOCKS a malformed form_name (not a slug) — no POST + error toast', () => {
    build({ id: 'site-1', slug: 'megabytespace' } as never);
    const post = TestBed.inject(ApiService).post as jasmine.Spy;
    const toastErr = TestBed.inject(ToastService).error as jasmine.Spy;
    post.calls.reset();
    component.testInput.form_name = 'Not A Slug!';
    expect(component.formNameInvalid()).withContext('spaces + ! → not a slug').toBeTrue();
    component.runTest();
    expect(post.calls.all().find((x) => String(x.args[0]).startsWith('/v1/forms/submit')))
      .withContext('a malformed form_name blocks the POST').toBeUndefined();
    expect(toastErr).toHaveBeenCalled();
  });

  it('formNameInvalid: empty is VALID (worker defaults to "default"); >64 + non-slug are invalid', () => {
    build({ id: 'site-1', slug: 'megabytespace' } as never);
    component.testInput.form_name = '';
    expect(component.formNameInvalid()).withContext('empty → valid (worker default)').toBeFalse();
    component.testInput.form_name = 'a'.repeat(65);
    expect(component.formNameInvalid()).withContext('>64 chars → invalid').toBeTrue();
    component.testInput.form_name = 'valid-slug_1';
    expect(component.formNameInvalid()).withContext('a real slug → valid').toBeFalse();
  });

  // The worker returns { data: { id } }; the FE read `data.submission_id` (always
  // undefined) → the inline AI-trace poll was ALWAYS skipped. Reading data.id fixes it.
  it('runTest reads data.id (not submission_id) → schedules the AI-trace poll after submit', fakeAsync(() => {
    build({ id: 'site-1', slug: 'megabytespace' } as never);
    const api = TestBed.inject(ApiService);
    (api.post as jasmine.Spy).and.returnValue(of({ data: { id: 'sub-9' } }));
    const getSpy = api.get as jasmine.Spy;
    getSpy.calls.reset();
    component.testInput.form_name = 'newsletter';
    component.testInput.fields_json = '{}';
    component.runTest();
    tick(700); // the poll is scheduled via setTimeout(poll, 700)
    const pollCall = getSpy.calls.all().find((x) => String(x.args[0]).includes('/form-submissions/sub-9'));
    expect(pollCall).withContext('data.id drives the trace poll (was submission_id → always skipped)').toBeTruthy();
    flush(); // drain the poll's re-scheduled timers so none leak into later specs
  }));

  // A submitter email in the table is a reply target — render it as a mailto: link
  // ([[always]] mandate). The cell stops propagation so clicking the link replies
  // without ALSO opening the submission detail (the rest of the row opens detail).
  it('renders the submitter email as a mailto: link in the submissions table', () => {
    build({ id: 'site-1' });
    component.submissions.set([
      { id: 's1', form_name: 'contact', email: 'jane@example.com', status: 'received', created_at: new Date().toISOString(), origin: 'x' } as never,
    ]);
    component.loading.set(false);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a[href^="mailto:"]') as HTMLAnchorElement;
    expect(link).withContext('email rendered as a mailto link').not.toBeNull();
    expect(link.getAttribute('href')).toBe('mailto:jane@example.com');
    expect(link.textContent?.trim()).toBe('jane@example.com');
  });

  // The enabled-MCP check is a monochrome SVG (cockpit semantic-status-glyph
  // standard, cross-OS consistent — matches domain-stack/swarm), inheriting the
  // pill's --brand colour via currentColor; never a bare ✓ font char.
  it('renders the enabled-MCP check as an SVG (not a bare ✓ char)', () => {
    build({ id: 'site-1' });
    component.designerOpen.set(true); // the MCP picker lives in the prompt-designer overlay
    component.mcpConnections.set([{ provider: 'github', label: 'GitHub', color: '#00e5ff', desc: 'GitHub MCP' }]);
    component.promptMcps.set(['github']); // enabled → the check shows on the pill
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const check = el.querySelector('.mcp-check');
    expect(check).withContext('the enabled MCP pill shows its check').not.toBeNull();
    expect(check!.querySelector('svg')).withContext('check is an SVG').not.toBeNull();
    expect(check!.textContent).not.toContain('✓');
  });

  it('renders a plain — (no mailto link) for an anonymous submission with no email', () => {
    build({ id: 'site-1' });
    component.submissions.set([
      { id: 's2', form_name: 'contact', email: '', status: 'received', created_at: new Date().toISOString(), origin: 'x' } as never,
    ]);
    component.loading.set(false);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('a[href^="mailto:"]'))
      .withContext('no link when there is no email').toBeNull();
  });

  // A projectsites-generated site ALREADY ships a working contact form — the empty state must NOT
  // tell the owner to "Drop the app.js snippet on your site" (confusing jargon for a site we built,
  // per embarrassingly-easy-to-use). It leads with the form being live + sets the expectation that
  // messages land here; the snippet stays only as a secondary "embed elsewhere" affordance.
  it('empty state leads with the form being LIVE, not the confusing "drop the app.js snippet" instruction', () => {
    build({ id: 'site-1' });
    component.submissions.set([]);
    component.loading.set(false);
    component.loadError.set(null);
    fixture.detectChanges();
    const empty = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="forms-empty"]');
    expect(empty).withContext('empty state renders with 0 submissions').toBeTruthy();
    const body = (empty?.querySelector('.empty-body')?.textContent ?? '').toLowerCase();
    expect(body).withContext('no confusing snippet-install instruction').not.toContain('drop the app.js snippet');
    expect(body).withContext('leads with the form already being live').toContain('already live');
    expect(body).withContext('sets the expectation that messages land here').toContain('lands right here');
  });

  // When submissions exist but the active VIEW filters out every one, the table
  // rendered header-only (blank body). Show a "no match" notice + a Show-all
  // reset instead. (filtered-list-blank class — forms was missed in that sweep.)
  it('shows a no-match notice (not a blank table) when a view filters out every submission', () => {
    build({ id: 'site-1' });
    component.submissions.set([
      { id: 's1', form_name: 'contact', email: 'a@b.com', status: 'received', created_at: new Date().toISOString(), origin: 'x' } as never,
    ]);
    component.loading.set(false);
    component.activeView.set('errors'); // status==='received' → excluded by the 'errors' view
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="forms-view-empty"]')).withContext('no-match notice shown').toBeTruthy();
    expect(host.querySelector('table')).withContext('no blank table rendered').toBeNull();
    (host.querySelector('[data-testid="forms-view-show-all"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.activeView()).withContext('Show-all resets the view').toBe('all');
    expect(host.querySelector('table')).withContext('table returns once the view is reset').toBeTruthy();
  });

  it('fires reload + loadSettings + loadMcp the instant the site resolves', () => {
    build(null);
    selectedSite.set({ id: 'site-1' });
    fixture.detectChanges();
    const urls = get.calls.allArgs().map((a) => a[0] as string);
    expect(urls.some((u) => u.includes('/form-submissions'))).toBe(true);
    expect(urls.some((u) => u.includes('/ai-settings'))).toBe(true);
    expect(urls.some((u) => u.includes('/mcp/connections'))).toBe(true);
  });

  it('does not re-load when the same site id is set again (guarded effect)', () => {
    build({ id: 'site-1' });
    const callsAfterMount = get.calls.count();
    selectedSite.set({ id: 'site-1' });
    fixture.detectChanges();
    expect(get.calls.count()).toBe(callsAfterMount);
  });

  it('renders the submissions count as an <app-rolling-counter> when submissions exist', () => {
    build({ id: 'site-1' });
    component.submissions.set([
      { id: 's1', form_name: 'newsletter', email: 'a@b.c', fields: {}, status: 'received', origin_url: null, ip_address: null, created_at: new Date().toISOString() },
    ]);
    fixture.detectChanges();
    const counter = fixture.nativeElement.querySelector('.header-pill app-rolling-counter');
    expect(counter).withContext('count pill must use the cinematic rolling-counter').toBeTruthy();
  });

  it('renders the load error through the shared <app-error-card> with a support reference', () => {
    build({ id: 'site-1' });
    component.submissions.set([]);
    component.loadError.set('Could not load submissions.');
    component.loadErrorRef.set('req_fm42');
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('app-error-card[data-testid="forms-load-error"]');
    expect(card).withContext('shared error-card primitive (not a bespoke empty-state error)').toBeTruthy();
    expect(card.querySelector('[data-testid="error-retry"]')).withContext('Retry on the card').toBeTruthy();
    expect(card.querySelector('[data-testid="error-correlation"]')?.textContent).withContext('worker request_id shown for support').toContain('req_fm42');
  });

  it('renders keyboard-openable submission rows (role=button + tabindex)', () => {
    build({ id: 'site-1' });
    component.submissions.set([
      { id: 's1', form_name: 'contact', email: null, fields: {}, status: 'received', origin_url: null, ip_address: null, created_at: new Date().toISOString() },
    ]);
    fixture.detectChanges();
    const row: HTMLElement | null = fixture.nativeElement.querySelector('.submission-row');
    expect(row).toBeTruthy();
    expect(row!.getAttribute('role')).toBe('button');
    expect(row!.getAttribute('tabindex')).toBe('0');
    expect(row!.getAttribute('aria-label')).toContain('contact');
  });

  it('countView returns 0 for an empty inbox and counts a matching view', () => {
    build({ id: 'site-1' });
    expect(component.countView('all')).toBe(0);
    component.submissions.set([
      { id: 's1', form_name: 'newsletter-signup', email: 'a@b.c', fields: {}, status: 'received', origin_url: null, ip_address: null, created_at: new Date().toISOString() },
    ]);
    expect(component.countView('newsletter')).toBe(1);
    expect(component.countView('with-email')).toBe(1);
  });

  it('applyTestScenario loads a sample + sets the active scenario', () => {
    build({ id: 'site-1' });
    component.applyTestScenario('contact');
    expect(component.activeScenario()).toBe('contact');
    expect(component.testInput.form_name).toBe('contact');
    expect(component.testInput.fields_json).toContain('submission');
  });

  it('onTestInputEdited clears the active scenario on a manual edit', () => {
    build({ id: 'site-1' });
    component.activeScenario.set('contact');
    component.onTestInputEdited();
    expect(component.activeScenario()).toBeNull();
  });

  it('togglePromptMcp toggles + persists the per-prompt MCP allow-list', () => {
    build({ id: 'site-1' });
    expect(component.isMcpEnabled('stripe')).toBe(false);
    component.togglePromptMcp('stripe');
    expect(component.isMcpEnabled('stripe')).toBe(true);
    expect(put).toHaveBeenCalled();
    component.togglePromptMcp('stripe');
    expect(component.isMcpEnabled('stripe')).toBe(false);
  });
});

/**
 * Guards the submissions load-error gating: a failed `/form-submissions` fetch
 * toasted but then fell through to the "No submissions yet" empty state — a
 * masquerade. Now a non-silent reload() sets a persistent loadError + Retry card;
 * a silent background poll keeps any loaded list and never raises the error.
 * overrideComponent strips the template so the constructor effect doesn't auto-fire.
 */
describe('AdminFormsComponent (submissions load-error gating)', () => {
  function makeErroring(get: jasmine.Spy): { c: AdminFormsComponent; toastErr: jasmine.Spy } {
    const toastErr = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      imports: [AdminFormsComponent],
      providers: [
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
        { provide: ApiService, useValue: { get, post: () => of({}), put: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: toastErr, success: () => undefined } },
        provideRouter([]),
      ],
    });
    TestBed.overrideComponent(AdminFormsComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminFormsComponent).componentInstance, toastErr };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('success populates submissions and leaves loadError null', () => {
    const { c } = makeErroring(jasmine.createSpy('get').and.returnValue(of({ data: [{ id: 'm1' }] })));
    c.reload();
    expect(c.loadError()).toBeNull();
    expect(c.submissions().length).toBe(1);
    expect(c.loading()).toBe(false);
  });

  it('a non-silent load error sets a persistent loadError banner ONLY — no toast (the read is {silent}, own toast dropped)', () => {
    const get = jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 })));
    const { c, toastErr } = makeErroring(get);
    c.reload();
    expect(c.loadError()).toContain('Could not load');
    expect(c.submissions().length).toBe(0);
    // the inline banner is the persistent UX; no transient toast on top, and the
    // read is {silent} so the generic ApiService toast can't fire either.
    expect(toastErr).not.toHaveBeenCalled();
    const call = get.calls.allArgs().find((a) => String(a[0]).includes('/form-submissions'));
    expect(call?.[2]).toEqual({ silent: true });
  });

  it('a SILENT poll failure does not raise loadError or toast', () => {
    const { c, toastErr } = makeErroring(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))));
    c.reload({ silent: true });
    expect(c.loadError()).toBeNull();
    expect(toastErr).not.toHaveBeenCalled();
  });

  it('retry after an error clears the prior loadError', () => {
    const get = jasmine.createSpy('get').and.returnValues(throwError(() => ({ status: 500 })), of({ data: [] }));
    const { c } = makeErroring(get);
    c.reload();
    expect(c.loadError()).not.toBeNull();
    c.reload();
    expect(c.loadError()).toBeNull();
  });
});

/**
 * WCAG 4.1.2 — the "test a submission" panel inputs (form_name / email /
 * fields-JSON) are placeholder-only with no visible <label>, so a screen
 * reader announced them with no purpose. Add aria-label.
 */
describe('AdminFormsComponent (test-panel accessible names)', () => {
  function render() {
    TestBed.configureTestingModule({
      imports: [AdminFormsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), put: () => of({}), post: () => of({ data: {} }) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
        provideRouter([]),
      ],
    });
    const fx = TestBed.createComponent(AdminFormsComponent);
    fx.detectChanges();
    fx.componentInstance.testOpen.set(true);
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  }
  const named = (el: HTMLElement, sel: string): boolean => {
    const c = el.querySelector(sel);
    return !!c && !!(c.getAttribute('aria-label') || (c.id && el.querySelector(`label[for="${c.id}"]`)));
  };
  afterEach(() => TestBed.resetTestingModule());

  it('form_name / email / fields inputs have accessible names', () => {
    const el = render();
    expect(named(el, 'input[placeholder^="form_name"]')).withContext('form_name').toBeTrue();
    expect(named(el, 'input[type="email"]')).withContext('email').toBeTrue();
    expect(named(el, 'textarea[placeholder^="Other fields"]')).withContext('fields json').toBeTrue();
  });
});

describe('AdminFormsComponent (submission-cap honesty)', () => {
  let fixture: ComponentFixture<AdminFormsComponent>;
  // Drives the REAL load path: the get mock returns `n` rows + the worker's
  // `meta.total` (defaults to `n` when omitted). The cap-note is honest — it fires
  // only when the store holds MORE than the loaded page (`total > n`), not merely
  // when the page is full.
  function render(n: number, total?: number): HTMLElement {
    const selectedSite = signal<{ id: string } | null>({ id: 's1' });
    const rows = Array.from({ length: n }, (_, i) => ({ id: 'x' + i, form_name: 'c', email: '', status: 'received', fields: {}, created_at: '', payload: '{}' }));
    const get = jasmine.createSpy('get').and.callFake((url: string) =>
      url.includes('/form-submissions')
        ? of({ data: rows, meta: { limit: 200, offset: 0, total: total ?? n, has_more: (total ?? n) > n } })
        : of({ data: {} }));
    TestBed.configureTestingModule({
      imports: [AdminFormsComponent],
      providers: [
        { provide: ApiService, useValue: { get, post: () => of({ data: {} }), put: () => of({ data: {} }), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, warning: () => 0, info: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite } },
        provideRouter([]),
      ],
    });
    fixture = TestBed.createComponent(AdminFormsComponent);
    fixture.detectChanges(); // ngOnInit → reload() populates submissions + metaTotal
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  it('shows an HONEST "latest N of M" note when more leads exist than are loaded (silent-truncation honesty)', () => {
    // 200 loaded, but the store holds 250 (meta.total) → the operator must know the
    // real count AND that 50 are not on screen. Old bug: hardcoded "latest 200" that
    // fired at exactly 200 loaded and hid the true total.
    const host = render(200, 250);
    const note = host.querySelector('[data-testid="forms-cap-note"]')?.textContent;
    expect(note).withContext('user must know older submissions exist').toContain('latest 200');
    expect(note).withContext('user must see the TRUE total').toContain('250');
  });

  it('does NOT show the cap note when everything is loaded (loaded === total)', () => {
    const host = render(12);
    expect(host.querySelector('[data-testid="forms-cap-note"]')).toBeNull();
  });

  it('does NOT show the cap note even at a full 200-row page when nothing is hidden (total === loaded)', () => {
    // A full page is not itself a truncation — the note must fire on hidden leads, not page-fullness.
    const host = render(200, 200);
    expect(host.querySelector('[data-testid="forms-cap-note"]')).toBeNull();
  });
});

/**
 * CSV export of form submissions (leads) — a standard SaaS list affordance.
 * Exports the currently-filtered rows: Date/Form/Email/Status + the union of
 * dynamic field keys. Hardened against CSV formula injection (a field starting
 * with =,+,-,@ is prefixed with ' so Excel/Sheets can't execute it) + RFC4180
 * escaping (commas/quotes/newlines).
 */
describe('AdminFormsComponent (submissions CSV export)', () => {
  function mount(): ComponentFixture<AdminFormsComponent> {
    const get = jasmine.createSpy('get').and.callFake((url: string) =>
      url.includes('/ai-settings')
        ? of({ data: { form_router_prompt: '', form_router_prompt_default: '', reply_email: '' } })
        : of({ data: [] }),
    );
    TestBed.configureTestingModule({
      imports: [AdminFormsComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get, put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      ],
    });
    const f = TestBed.createComponent(AdminFormsComponent);
    f.detectChanges();
    return f;
  }
  afterEach(() => TestBed.resetTestingModule());

  const row = (over: Partial<Record<string, unknown>> = {}) =>
    ({ id: 'x', form_name: 'contact', email: 'a@b.com', fields: {}, status: 'new', origin_url: null, ip_address: null, created_at: '2026-06-06T00:00:00Z', ...over }) as never;

  it('buildSubmissionsCsv emits a header + a row, unions field keys, guards formulas, escapes commas', () => {
    const c = mount().componentInstance;
    const csv = (c as unknown as { buildSubmissionsCsv(r: unknown[]): string }).buildSubmissionsCsv([
      row({ fields: { message: 'hi, there', danger: '=SUM(A1)' } }),
    ]);
    // Shared toCsv() joins with '\n' and adds a trailing newline (RFC-4180-safe).
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toContain('Date');
    expect(lines[0]).toContain('Email');
    expect(lines[0]).toContain('danger');
    expect(lines[0]).toContain('message');
    expect(csv).withContext('formula-injection guard prefixes a leading =').toContain("'=SUM(A1)");
    expect(csv).withContext('a value with a comma is quoted').toContain('"hi, there"');
    expect(lines.length).withContext('header + 1 data row').toBe(2);
  });

  it('exportCsv no-ops when there are no filtered rows (the button is also disabled)', () => {
    const c = mount().componentInstance;
    c.submissions.set([]);
    const spy = spyOn(document, 'createElement').and.callThrough();
    (c as unknown as { exportCsv(): void }).exportCsv();
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders an Export CSV button, disabled when the filtered list is empty', () => {
    const f = mount();
    f.componentInstance.submissions.set([]);
    f.detectChanges();
    const btn = (f.nativeElement as HTMLElement).querySelector('[data-testid="forms-export-csv"]') as HTMLButtonElement;
    expect(btn).withContext('Export CSV button present').toBeTruthy();
    expect(btn.disabled).withContext('disabled with no rows to export').toBeTrue();
  });
});

/**
 * Bulk-select → Export selected (Mission "bulk actions where useful"). Per-row
 * checkboxes + a header select-all; the Export button acts on the SELECTION when
 * any rows are picked, else all filtered rows. The checkbox cell stops click
 * propagation so ticking a box never opens the row's detail panel.
 */
describe('AdminFormsComponent (bulk-select submissions → export selected)', () => {
  function mount(): ComponentFixture<AdminFormsComponent> {
    const get = jasmine.createSpy('get').and.callFake((url: string) =>
      url.includes('/ai-settings')
        ? of({ data: { form_router_prompt: '', form_router_prompt_default: '', reply_email: '' } })
        : of({ data: [] }),
    );
    TestBed.configureTestingModule({
      imports: [AdminFormsComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get, put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      ],
    });
    const f = TestBed.createComponent(AdminFormsComponent);
    f.detectChanges();
    return f;
  }
  afterEach(() => TestBed.resetTestingModule());

  const sub = (id: string) =>
    ({ id, form_name: 'contact', email: id + '@b.com', fields: {}, status: 'new', origin_url: null, ip_address: null, created_at: '2026-06-06T00:00:00Z' }) as never;

  it('exportRows() is all-filtered with no selection, and just the selection once rows are picked', () => {
    const c = mount().componentInstance;
    c.submissions.set([sub('a'), sub('b'), sub('c')]);
    expect(c.exportRows().length).withContext('no selection → export all filtered').toBe(3);
    c.toggleSelect('b');
    expect(c.exportRows().map((r: { id: string }) => r.id)).withContext('selection → only picked rows').toEqual(['b']);
    c.toggleSelect('b'); // untick
    expect(c.exportRows().length).withContext('back to all filtered').toBe(3);
  });

  it('toggleSelectAll selects every filtered row, then clears on a second toggle', () => {
    const c = mount().componentInstance;
    c.submissions.set([sub('a'), sub('b')]);
    c.toggleSelectAll();
    expect(c.allFilteredSelected()).toBeTrue();
    expect(c.exportRows().length).toBe(2);
    c.toggleSelectAll();
    expect(c.allFilteredSelected()).toBeFalse();
    expect(c.selectedIds().size).toBe(0);
  });

  it('switching the saved view clears the selection (no stale cross-view picks)', () => {
    const c = mount().componentInstance;
    c.submissions.set([sub('a')]);
    c.toggleSelect('a');
    expect(c.selectedIds().size).toBe(1);
    c.setView('all');
    expect(c.selectedIds().size).withContext('selection resets per view').toBe(0);
  });

  it('wraps the submissions table in a keyboard-scrollable overflow-x region (WCAG 1.4.10 — no page overflow at 320px with the extra checkbox column)', () => {
    const f = mount();
    f.componentInstance.submissions.set([sub('a')]);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    const region = host.querySelector('[data-testid="forms-table-scroll"]') as HTMLElement;
    expect(region).withContext('scroll region present').toBeTruthy();
    expect(region.classList.contains('overflow-x-auto')).withContext('horizontal scroll, not page overflow').toBeTrue();
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).withContext('keyboard-scrollable').toBe('0');
    expect(region.querySelector('table')).withContext('the table lives inside the scroll region').toBeTruthy();
  });

  it('renders a select-all header checkbox + a per-row checkbox; export label reflects the selection', () => {
    const f = mount();
    f.componentInstance.submissions.set([sub('a'), sub('b')]);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="forms-select-all"]')).withContext('select-all checkbox present').toBeTruthy();
    expect(host.querySelector('[data-testid="forms-row-select-a"]')).withContext('per-row checkbox present').toBeTruthy();
    f.componentInstance.toggleSelect('a');
    f.detectChanges();
    const btn = host.querySelector('[data-testid="forms-export-csv"]') as HTMLButtonElement;
    expect(btn.textContent ?? '').withContext('label switches to "Export N selected"').toContain('1 selected');
  });

  it('shows a Clear button only while rows are selected; clicking it deselects all', () => {
    const f = mount();
    f.componentInstance.submissions.set([sub('a'), sub('b')]);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="forms-clear-selection"]')).withContext('hidden with no selection').toBeNull();

    f.componentInstance.toggleSelect('a'); // partial
    f.detectChanges();
    const clear = host.querySelector('[data-testid="forms-clear-selection"]') as HTMLButtonElement;
    expect(clear).withContext('Clear button appears once a row is selected').toBeTruthy();

    clear.click();
    f.detectChanges();
    expect(f.componentInstance.selectedIds().size).withContext('one click clears the whole selection').toBe(0);
    expect(host.querySelector('[data-testid="forms-clear-selection"]')).withContext('hidden again once cleared').toBeNull();
  });

  it('the select-all header checkbox shows the INDETERMINATE state on a partial selection', () => {
    const f = mount();
    f.componentInstance.submissions.set([sub('a'), sub('b')]);
    f.detectChanges();
    const all = (f.nativeElement as HTMLElement).querySelector('[data-testid="forms-select-all"]') as HTMLInputElement;
    expect(all.indeterminate).withContext('none selected → not indeterminate').toBeFalse();
    expect(all.checked).toBeFalse();

    f.componentInstance.toggleSelect('a'); // 1 of 2 → partial
    f.detectChanges();
    expect(all.indeterminate).withContext('partial selection → indeterminate dash').toBeTrue();
    expect(all.checked).withContext('partial is not "checked"').toBeFalse();

    f.componentInstance.toggleSelect('b'); // 2 of 2 → all
    f.detectChanges();
    expect(all.indeterminate).withContext('all selected → solid check, not indeterminate').toBeFalse();
    expect(all.checked).toBeTrue();
  });
});
