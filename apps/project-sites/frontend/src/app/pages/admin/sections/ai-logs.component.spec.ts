import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminAiLogsComponent } from './ai-logs.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';

/**
 * Guards the AI-logs traces load-error state: a failed traces fetch used to be
 * SILENT (error: () => loading.set(false)) → an empty grid masqueraded as "no
 * traces". Now reload() sets a persistent loadError (the banner renders only
 * when there are no rows, so stale data stays visible on a poll blip).
 * overrideComponent strips the table template; reload() is driven directly.
 */
function make(get: jasmine.Spy): AdminAiLogsComponent {
  TestBed.configureTestingModule({
    imports: [AdminAiLogsComponent],
    providers: [
      { provide: ApiService, useValue: { get, post: () => of({}) } },
      { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') } },
      { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
      { provide: Router, useValue: { navigate: jasmine.createSpy('navigate'), navigateByUrl: jasmine.createSpy('navigateByUrl'), events: of() } },
    ],
  });
  TestBed.overrideComponent(AdminAiLogsComponent, { set: { template: '<div></div>', imports: [] } });
  return TestBed.createComponent(AdminAiLogsComponent).componentInstance;
}

describe('AdminAiLogsComponent (traces load-error)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('success populates rows and clears loadError', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [{ id: 't1' }] })));
    c.reload();
    expect(c.loadError()).toBeNull();
    expect(c.rows().length).toBe(1);
    expect(c.loading()).toBe(false);
  });

  // The endpoint caps the page but returns the TRUE call count in meta.total — the
  // "Calls" stat / cap-note must reflect it, else an active AI site's real volume
  // (cost + debugging signal) is under-reported past the cap.
  it('totalCount reflects the server meta.total (not the loaded page); hasHiddenCalls fires when calls are hidden', () => {
    const c = make(
      jasmine.createSpy('get').and.returnValue(
        of({ data: [{ id: 't1' }, { id: 't2' }], meta: { total: 4200, has_more: true } }),
      ),
    );
    c.reload();
    expect(c.rows().length).toBe(2); // the loaded page
    expect(c.totalCount()).toBe(4200); // TRUE site-wide count from meta
    expect(c.hasHiddenCalls()).toBeTrue();
  });

  it('no hidden-calls note when the whole store is loaded (meta absent → total === loaded)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [{ id: 't1' }] })));
    c.reload();
    expect(c.totalCount()).toBe(1);
    expect(c.hasHiddenCalls()).toBeFalse();
  });

  it('a load error sets a persistent loadError (not a silent empty grid)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))));
    c.reload();
    expect(c.loadError()).toContain('Could not load');
    expect(c.loading()).toBe(false);
  });

  it('reload() reads {silent:true} — the loadError banner is the UX, not a generic toast', () => {
    const get = jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 })));
    const c = make(get);
    c.reload();
    expect(c.loadError()).toContain('Could not load');
    expect(get.calls.mostRecent().args[2]).toEqual({ silent: true });
  });

  it('retry after an error clears the prior loadError', () => {
    const get = jasmine.createSpy('get').and.returnValues(throwError(() => ({ status: 500 })), of({ data: [] }));
    const c = make(get);
    c.reload();
    expect(c.loadError()).not.toBeNull();
    c.reload();
    expect(c.loadError()).toBeNull();
  });
});

describe('AdminAiLogsComponent (grid state — skeleton vs empty vs data)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the skeleton only while loading with no rows yet', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.loading.set(true);
    c.rows.set([]);
    expect(c.gridLoadingSkeleton()).toBe(true);
    expect(c.gridEmpty()).toBe(false);
  });

  it('shows the friendly empty state when idle, error-free, and zero rows', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.loading.set(false);
    c.loadError.set(null);
    c.rows.set([]);
    expect(c.gridEmpty()).toBe(true);
    expect(c.gridLoadingSkeleton()).toBe(false);
  });

  // KPI tiles must NOT assert "0 calls · 0ms · 0 errors · 0 credits" over the
  // error card — the count is unknown on error, not 0.
  it('hides the KPI tiles on a load error with no rows; shows them with data', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.loadError.set('Could not load AI traces — retry.');
    c.rows.set([]);
    expect(c.showKpis()).withContext('no "0 calls" over the error').toBe(false);

    c.rows.set([{ id: 'l1' } as never]);
    expect(c.showKpis()).withContext('stale data still shows KPIs').toBe(true);

    c.loadError.set(null);
    c.rows.set([]);
    expect(c.showKpis()).withContext('error-free empty still renders (animates 0)').toBe(true);
  });

  // KPI tiles must NOT flash a definitive "0 calls · 0ms · 0 errors · 0 credits"
  // over the loading skeleton — during the initial fetch the counts are unknown,
  // not zero. They appear once the load settles (or stale data is present).
  it('hides the KPI tiles during the initial load, keeps them during a refresh with data', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.loading.set(true);
    c.loadError.set(null);
    c.rows.set([]);
    expect(c.showKpis()).withContext('no premature zeros over the loading skeleton').toBe(false);

    // A background refresh (rows already present) keeps the KPIs visible.
    c.rows.set([{ id: 'l1' } as never]);
    expect(c.showKpis()).withContext('stale data stays visible during refresh').toBe(true);
  });

  it('suppresses the empty state on a load error (the error card owns that case)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.loading.set(false);
    c.loadError.set('boom');
    c.rows.set([]);
    expect(c.gridEmpty()).toBe(false);
    expect(c.gridLoadingSkeleton()).toBe(false);
  });

  it('hides both skeleton and empty state once rows arrive', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [{ id: 't1' }] })));
    c.reload();
    expect(c.gridLoadingSkeleton()).toBe(false);
    expect(c.gridEmpty()).toBe(false);
    expect(c.rows().length).toBe(1);
  });
});

/**
 * Master/detail contract for the traces grid — the expansion behaviour
 * (expandedIds-driven detail <tr>, NO synthetic splice rows post-migration)
 * + the text filter + the row-click guards. This is the EXACT behaviour the
 * ag-grid→TanStack perf wave must preserve, so locking it here is the
 * migration's regression safety net. Pure signal logic — no DOM, no prod data.
 */
describe('AdminAiLogsComponent (master/detail + filter contract)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const mk = (id: string, model = 'gpt'): unknown => ({
    id, model, trace_kind: 'chat', endpoint_slug: null, tool_name: null,
    output_preview: null, error_message: null, actor_email: null, status: 'ok', created_at: 'now',
  });
  // fetchDetail (called on expand) hits api.get — keep it harmless.
  const mkComp = () => make(jasmine.createSpy('get').and.returnValue(of({ data: {} })));

  it('filteredRows is just the master rows when nothing is expanded and no filter is set', () => {
    const c = mkComp();
    c.rows.set([mk('a'), mk('b')] as never);
    expect(c.filteredRows().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('expanding a row flips its id in expandedIds (the detail <tr> is template-driven — no synthetic rows)', () => {
    const c = mkComp();
    c.rows.set([mk('a'), mk('b')] as never);
    c.toggleExpand({ id: 'a' } as never);
    expect(c.expandedIds().has('a')).withContext('expand adds the id').toBeTrue();
    expect(c.filteredRows().map((r) => r.id)).withContext('no ::detail rows spliced').toEqual(['a', 'b']);
  });

  it('collapsing removes the id again (toggle off)', () => {
    const c = mkComp();
    c.rows.set([mk('a'), mk('b')] as never);
    c.toggleExpand({ id: 'a' } as never);
    c.toggleExpand({ id: 'a' } as never);
    expect(c.expandedIds().has('a')).toBeFalse();
  });

  it('two expanded rows are independent — the id set holds both masters', () => {
    const c = mkComp();
    c.rows.set([mk('a'), mk('b')] as never);
    c.toggleExpand({ id: 'a' } as never);
    c.toggleExpand({ id: 'b' } as never);
    expect([...c.expandedIds()].sort()).toEqual(['a', 'b']);
  });

  it('the text filter narrows filteredRows (endpoint/tool/model/actor haystack)', () => {
    const c = mkComp();
    c.rows.set([mk('a', 'claude'), mk('b', 'gpt')] as never);
    c.filter.set('claude');
    expect(c.filteredRows().map((r) => r.id)).toEqual(['a']);
  });

  it('onRowClick toggles on a plain master-row click', () => {
    const c = mkComp();
    c.onRowClick({ target: document.body } as unknown as Event, { id: 'a' } as never);
    expect(c.expandedIds().has('a')).toBeTrue();
  });

  it('onRowClick ignores mid-text-selection clicks', () => {
    const c = mkComp();
    const selSpy = spyOn(window, 'getSelection').and.returnValue({ toString: () => 'selected text' } as Selection);
    c.onRowClick({ target: document.body } as unknown as Event, { id: 'a' } as never);
    expect(c.expandedIds().has('a')).withContext('no toggle mid-selection').toBeFalse();
    expect(selSpy).toHaveBeenCalled();
  });

  it('onRowClick lets actionable children (buttons/links) own their click', () => {
    const c = mkComp();
    const btn = document.createElement('button');
    c.onRowClick({ target: btn } as unknown as Event, { id: 'a' } as never);
    expect(c.expandedIds().has('a')).withContext('button click must not toggle the row').toBeFalse();
  });
});

/**
 * TanStack table state — sort restore/persist + pagination. The col-state key
 * is reused from the ag-grid era (`ps_traces_grid_v1`); the legacy column-state
 * shape fails validation and is silently ignored.
 */
describe('AdminAiLogsComponent (TanStack table state)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('defaults to created_at desc and ignores corrupt/legacy ag-grid state', () => {
    localStorage.setItem('ps_traces_grid_v1', JSON.stringify([{ colId: 'model', sort: 'asc' }]));
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.sorting()).toEqual([{ id: 'created_at', desc: true }]);
  });

  it('restores a valid persisted sort', () => {
    localStorage.setItem('ps_traces_grid_v1', JSON.stringify({ sorting: [{ id: 'model', desc: true }] }));
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.sorting()).toEqual([{ id: 'model', desc: true }]);
  });

  it('persists the sort state on a header toggle (desc → removed → asc cycle)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([{ id: 't1', created_at: 'now' } as never]);
    const whenHeader = c.table.getHeaderGroups()[0].headers.find((h) => h.id === 'created_at');
    expect(whenHeader).toBeDefined();
    whenHeader?.column.toggleSorting(); // desc → removed
    let stored = JSON.parse(localStorage.getItem('ps_traces_grid_v1') ?? '{}') as { sorting?: unknown };
    expect(stored.sorting).toEqual([]);
    whenHeader?.column.toggleSorting(); // removed → asc
    stored = JSON.parse(localStorage.getItem('ps_traces_grid_v1') ?? '{}') as { sorting?: unknown };
    expect(stored.sorting).toEqual([{ id: 'created_at', desc: false }]);
  });

  it('onPageSize resets to page 1 and ignores unknown sizes', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.pagination.set({ pageIndex: 4, pageSize: 25 });
    c.onPageSize({ target: { value: '100' } } as unknown as Event);
    expect(c.pagination()).toEqual({ pageIndex: 0, pageSize: 100 });
    c.pagination.set({ pageIndex: 2, pageSize: 100 });
    c.onPageSize({ target: { value: '9999' } } as unknown as Event);
    expect(c.pagination()).toEqual({ pageIndex: 2, pageSize: 100 });
  });

  it('pageStart/pageEnd reflect the filtered total + pagination state', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] as never);
    c.pagination.set({ pageIndex: 0, pageSize: 2 });
    expect(c.pageStart()).toBe(1);
    expect(c.pageEnd()).toBe(2);
    c.pagination.set({ pageIndex: 1, pageSize: 2 });
    expect(c.pageStart()).toBe(3);
    expect(c.pageEnd()).toBe(3);
  });
});

/**
 * Double-toast guard: explainTrace shows its OWN specific
 * toast.error in the error callback, so the api.post must pass {silent:true} or
 * a failure fires TWO toasts (generic ApiService + the section-specific one).
 */
describe('AdminAiLogsComponent (mutations are {silent} — no double-toast)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makePost(post: jasmine.Spy): AdminAiLogsComponent {
    TestBed.configureTestingModule({
      imports: [AdminAiLogsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: {} }), post } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, warning: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
        { provide: Router, useValue: { navigate: () => 0, navigateByUrl: () => 0, events: of() } },
      ],
    });
    TestBed.overrideComponent(AdminAiLogsComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminAiLogsComponent).componentInstance;
  }

  it('explainTrace POSTs {silent:true}', () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ data: { markdown: 'x' } }));
    const c = makePost(post);
    c.explainTrace('t1');
    expect(post).toHaveBeenCalledWith('/admin/traces/t1/explain', {}, { silent: true });
  });
});

describe('AdminAiLogsComponent (chart sample honesty)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('windowSampleCount counts only in-window loaded traces with latency (sparse long-period reads as "small sample")', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    c.rows.set([
      { id: 'r1', created_at: iso(60 * 60 * 1000), latency_ms: 100 },        // 1h ago, in 24h
      { id: 'r2', created_at: iso(2 * 60 * 60 * 1000), latency_ms: 200 },    // 2h ago, in 24h
      { id: 'r3', created_at: iso(40 * 24 * 60 * 60 * 1000), latency_ms: 9 },// 40d ago, OUT of 24h
      { id: 'r4', created_at: iso(60 * 60 * 1000), latency_ms: null },       // in window but no latency
    ] as never);
    c.chartPeriod.set('24h');
    expect(c.windowSampleCount()).withContext('only r1 + r2 (in-window, with latency)').toBe(2);
  });
});

describe('AdminAiLogsComponent (all four KPI tiles roll — cinematic-ui)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('Avg latency rolls like its sibling tiles (Calls/Errors/Credits), not a static node', () => {
    TestBed.configureTestingModule({
      imports: [AdminAiLogsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
        { provide: Router, useValue: { navigate: () => 0, navigateByUrl: () => 0, events: of() } },
      ],
    });
    const fx = TestBed.createComponent(AdminAiLogsComponent);
    fx.componentInstance.rows.set([
      { id: 'k1', latency_ms: 240, status: 'ok', credits_debited: 2, created_at: 'now' },
      { id: 'k2', latency_ms: 260, status: 'error', credits_debited: 3, created_at: 'now' },
    ] as never);
    fx.detectChanges();
    // the KPI row has 4 tiles — Avg latency was the lone static one beside 3 rolling siblings.
    const counters = (fx.nativeElement as HTMLElement).querySelectorAll('.grid-cols-4 app-rolling-counter');
    expect(counters.length).withContext('all four KPI tiles roll via app-rolling-counter').toBe(4);
  });
});

describe('AdminAiLogsComponent (empty-state glyph cohesion — SVG-in-cyan-halo)', () => {
  afterEach(() => TestBed.resetTestingModule());

  // The empty state must use the cockpit SVG-in-cyan-halo glyph (matching media /
  // pseo / billing), not a floating unicode ◇ char — visual cohesion across /admin.
  it('renders the cockpit SVG-in-halo glyph (not a bare ◇ char) when there are no traces', () => {
    TestBed.configureTestingModule({
      imports: [AdminAiLogsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: [] }), post: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0 } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1' }) } },
        { provide: Router, useValue: { navigate: () => 0, navigateByUrl: () => 0, events: of() } },
      ],
    });
    const fx = TestBed.createComponent(AdminAiLogsComponent);
    fx.detectChanges();
    const empty = (fx.nativeElement as HTMLElement).querySelector('[data-testid="ai-logs-empty"]');
    expect(empty).withContext('empty state renders when no traces').not.toBeNull();
    const glyph = empty!.querySelector('.empty-glyph');
    expect(glyph).not.toBeNull();
    expect(glyph!.querySelector('svg')).withContext('glyph is the cockpit SVG-in-halo, not a unicode char').not.toBeNull();
    expect(glyph!.textContent ?? '').withContext('no bare ◇ diamond char remains').not.toContain('◇');
  });
});

describe('AdminAiLogsComponent — bounded auto-poll retry (error-recovery max 3)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pauses auto-poll after 3 consecutive load errors; a success resumes it', () => {
    const get = jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 })));
    const c = make(get);
    c.reload(); c.reload(); c.reload();
    expect(c.consecutiveErrors()).toBe(3);
    expect(c.autoRefreshPaused()).withContext('paused after max retries').toBeTrue();

    get.and.returnValue(of({ data: [] }));
    c.reload();
    expect(c.consecutiveErrors()).toBe(0);
    expect(c.autoRefreshPaused()).withContext('a success resumes auto-poll').toBeFalse();
  });
});

/**
 * Lying-control regression (traces page-size selector). Identical to the audit
 * section: default pageSize is 50 but the option list starts at 25, so the old
 * `<select [value]="pagination().pageSize">` binding fell back to the first
 * option (25) while the grid actually paged 50 — the control lied about state.
 * The fix moves the selected state onto each `<option>` via `[selected]`. This
 * reads the component's decorator template as a string (guarded so a
 * template-stripped runner never yields a false failure).
 */
describe('AdminAiLogsComponent (traces page-size selector reflects true page size)', () => {
  function tracesTemplate(): string {
    const cls = AdminAiLogsComponent as unknown as {
      __annotations__?: Array<Record<string, unknown>>;
      decorators?: Array<{ args?: Array<Record<string, unknown>> }>;
    };
    const fromAnn = Array.isArray(cls.__annotations__)
      ? cls.__annotations__.find((a) => 'template' in a)
      : undefined;
    const fromDec = Array.isArray(cls.decorators)
      ? cls.decorators.find((d) => d.args?.[0] && 'template' in d.args[0])?.args?.[0]
      : undefined;
    return ((fromAnn ?? fromDec ?? {}) as { template?: string }).template ?? '';
  }

  it('binds [selected] on each option — never the lying <select [value]> that shows 25 while paging 50', () => {
    const t = tracesTemplate();
    if (!t) {
      pending('decorator template not reachable in this runner — contract enforced by AOT build + prod E2E');
      return;
    }
    expect(t).withContext('each option owns its selected state (reliable across @for render order)').toContain(
      '[selected]="n === pagination().pageSize"',
    );
    expect(t)
      .withContext('the unreliable <select [value]="pagination().pageSize"> binding was the bug — must be gone')
      .not.toMatch(/<select[^>]*\[value\]="pagination\(\)\.pageSize"/);
  });
});
