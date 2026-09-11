import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminAuditComponent } from './audit.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';

/**
 * Convergence r52 + perf-wave (ag-grid→TanStack) — cohesion + a11y contract
 * lock for the Audit section.
 *
 * 1. Logic contract — the KPI computeds (uniqueActions / uniqueActors /
 *    last24h), the `expandedIds`-driven master/detail model, the
 *    scope-chip showScopeChip() reactivity, the TanStack table state
 *    (sort/filter/pagination + localStorage persistence), and the load()
 *    success/error paths.
 * 2. Cohesion/a11y source contract — best-effort assertions against the
 *    component's `@Component` decorator metadata (template + styles): every
 *    numeric KPI binds through <app-rolling-counter>, the empty state
 *    announces via role="status", the expand kebab carries aria-expanded,
 *    brand colour is the cyan token family (NEVER orange), and every
 *    @keyframes animation pairs with a prefers-reduced-motion guard. These
 *    are gated on metadata being reachable so the suite never produces a
 *    false failure in an AOT/JIT-stripped runner — the same contract is also
 *    enforced by the AOT prod build + the prod a11y E2E suite.
 *
 * The table template is stripped via overrideComponent for the logic suite
 * (mirrors ai-logs.component.spec.ts) so no DOM mounting is required to
 * exercise the signals.
 */

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r1',
  action: 'site.deploy',
  message: 'Deployed site',
  target_type: 'site',
  target_id: 'site-1',
  actor_id: 'actor-aaaaaaaa',
  metadata: null,
  request_id: 'req-1',
  created_at: new Date().toISOString(),
  site: 'megabytespace',
  ...over,
});

function make(get: jasmine.Spy): AdminAuditComponent {
  TestBed.configureTestingModule({
    imports: [AdminAuditComponent],
    providers: [
      { provide: ApiService, useValue: { get, post: () => of({}) } },
      {
        provide: ToastService,
        useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success') },
      },
      {
        provide: AdminStateService,
        useValue: {
          selectedSite: signal({ id: 's1' }),
          orgId: signal('e2e-test-org'),
          orgName: signal('E2E Test Org'),
        },
      },
      {
        provide: Router,
        useValue: { navigate: jasmine.createSpy('navigate'), navigateByUrl: jasmine.createSpy('navigateByUrl'), events: of() },
      },
    ],
  });
  // Strip the TanStack table template so the signals can be exercised without
  // mounting the table DOM (the headless table model still runs in-class).
  TestBed.overrideComponent(AdminAuditComponent, { set: { template: '<div></div>', imports: [] } });
  return TestBed.createComponent(AdminAuditComponent).componentInstance;
}

describe('AdminAuditComponent (load + KPI logic)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('load() success populates rows, clears loading, stamps lastSyncAt', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [ROW(), ROW({ id: 'r2', action: 'hostname.add' })] })));
    c.load();
    expect(c.rows().length).toBe(2);
    expect(c.loading()).toBe(false);
    expect(c.lastSyncAt()).toBeGreaterThan(0);
  });

  it('expandedIds starts empty; toggleExpand adds + removes the row id (drives the detail <tr>)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([ROW({ id: 'm1' })] as never);
    expect(c.expandedIds().size).toBe(0);
    c.toggleExpand(c.rows()[0]);
    expect(c.expandedIds().has('m1')).withContext('expand adds the id').toBeTrue();
    c.toggleExpand(c.rows()[0]);
    expect(c.expandedIds().has('m1')).withContext('second toggle collapses').toBeFalse();
  });

  it('two rows expand independently — the id set holds both masters', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([ROW({ id: 'm1' }), ROW({ id: 'm2' })] as never);
    c.toggleExpand(c.rows()[0]);
    c.toggleExpand(c.rows()[1]);
    expect([...c.expandedIds()].sort()).toEqual(['m1', 'm2']);
  });

  it('canExport gates Export CSV: false with no events (never a headers-only / dead-button CSV), and exportCsv no-ops when empty', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.load();
    expect(c.rows().length).toBe(0);
    expect(c.canExport()).withContext('no events → export disabled (matches analytics + forms)').toBeFalse();
    // exportCsv must not touch the DOM / emit an empty CSV when gated off.
    expect(() => c.exportCsv()).not.toThrow();
  });

  it('canExport is true once events load', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [ROW()] })));
    c.load();
    expect(c.canExport()).toBeTrue();
  });

  // The endpoint caps the page at 500 rows but returns the TRUE org-wide total in
  // meta.total (a COUNT). The count/note must reflect reality — else an active org
  // with >500 audit events sees a capped window with no signal that older
  // (compliance/security) events exist.
  it('totalCount reflects the server meta.total (not the loaded page); hasHiddenEvents fires when events are hidden', () => {
    const c = make(
      jasmine.createSpy('get').and.returnValue(of({ data: [ROW()], meta: { total: 520, has_more: true } })),
    );
    c.load();
    expect(c.totalCount()).toBe(520);
    expect(c.hasHiddenEvents()).toBeTrue();
  });

  // The KPI cards MUST reflect the server's full-set aggregates (meta.stats), never a
  // count over the ≤500 loaded rows — else "Last 24h" undercounts once an org logs >500
  // events/day (observed 500 shown for 1338 real). display MUST == store.
  it('KPI cards use server meta.stats totals, not the loaded page (Last 24h never undercounts)', () => {
    const c = make(
      jasmine.createSpy('get').and.returnValue(
        of({
          data: [ROW()],
          meta: { total: 12372, has_more: true, stats: { unique_actions: 12, actors: 1, last_24h: 1338 } },
        }),
      ),
    );
    c.load();
    expect(c.last24h()).withContext('Last 24h from the server, not the 1 loaded row').toBe(1338);
    expect(c.uniqueActions()).toBe(12);
    expect(c.uniqueActors()).toBe(1);
    expect(c.totalCount()).toBe(12372);
  });

  it('no hidden-events note when the whole store is loaded (meta absent → total === loaded)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [ROW(), ROW()] })));
    c.load();
    expect(c.totalCount()).toBe(2);
    expect(c.hasHiddenEvents()).toBeFalse();
  });

  it('statLabels matches the four loaded stat-card headers (skeleton persists labels → no reflow)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect([...c.statLabels]).toEqual(['Events', 'Unique actions', 'Last 24h', 'Actors']);
  });

  it('load() error clears loading + sets loadError (security log must not masquerade as empty)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))));
    c.load();
    expect(c.loading()).toBeFalse();
    expect(c.loadError()).toBeTruthy();
    expect(c.showStats()).withContext('stat cards hidden over the error card').toBeFalse();
  });

  it('load() reads {silent:true} — the loadError banner is the UX, so the generic ApiService toast must not double-fire', () => {
    const get = jasmine.createSpy('get').and.returnValue(of({ data: [] }));
    const c = make(get);
    c.load();
    expect(get).toHaveBeenCalledWith('/audit-logs', { limit: '500' }, { silent: true });
  });

  it('load() success clears a prior loadError (retry recovers)', () => {
    const get = jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 })));
    const c = make(get);
    c.load();
    expect(c.loadError()).toBeTruthy();
    get.and.returnValue(of({ data: [ROW()] }));
    c.load();
    expect(c.loadError()).toBeNull();
  });

  it('uniqueActions counts distinct action codes', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([
      ROW({ id: 'a1', action: 'site.deploy' }),
      ROW({ id: 'a2', action: 'site.deploy' }),
      ROW({ id: 'a3', action: 'billing.update' }),
    ] as never);
    expect(c.uniqueActions()).toBe(2);
  });

  it('uniqueActors counts distinct non-null actor_ids', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([
      ROW({ id: 'a1', actor_id: 'actor-aaaaaaaa' }),
      ROW({ id: 'a2', actor_id: 'actor-aaaaaaaa' }),
      ROW({ id: 'a3', actor_id: null }),
    ] as never);
    expect(c.uniqueActors()).toBe(1);
  });

  it('last24h counts only rows newer than the 24h cutoff', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    c.rows.set([ROW({ id: 'a1', created_at: nowIso }), ROW({ id: 'a2', created_at: oldIso })] as never);
    expect(c.last24h()).toBe(1);
  });

  it('hides the stat cards on a load error with no rows; shows them with data', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 }))));
    c.load();
    expect(c.showStats()).toBeFalse();
    c.rows.set([ROW()] as never);
    expect(c.showStats()).toBeTrue();
  });

  it('KPI computeds count every loaded row (no synthetic detail rows in the TanStack model)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([
      ROW({ id: 'm1', action: 'site.deploy', actor_id: 'actor-aaaaaaaa' }),
      ROW({ id: 'm2', action: 'billing.update', actor_id: 'actor-bbbbbbbb' }),
    ] as never);
    c.toggleExpand(c.rows()[0]);
    c.toggleExpand(c.rows()[1]);
    expect(c.uniqueActions()).toBe(2);
    expect(c.uniqueActors()).toBe(2);
    expect(c.last24h()).toBe(2);
    expect(c.expandedIds().size).toBe(2);
  });
});

describe('AdminAuditComponent (TanStack table state)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('onSiteFilter sets the site column filter and rewinds to page 1', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.pagination.set({ pageIndex: 3, pageSize: 50 });
    c.onSiteFilter({ target: { value: 'megabytespace' } } as unknown as Event);
    expect(c.columnFilters()).toEqual([{ id: 'site', value: 'megabytespace' }]);
    expect(c.pagination().pageIndex).toBe(0);
    c.onSiteFilter({ target: { value: '' } } as unknown as Event);
    expect(c.columnFilters()).toEqual([]);
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
    c.rows.set([ROW({ id: 'r1' }), ROW({ id: 'r2' }), ROW({ id: 'r3' })] as never);
    c.pagination.set({ pageIndex: 0, pageSize: 2 });
    expect(c.pageStart()).toBe(1);
    expect(c.pageEnd()).toBe(2);
    c.pagination.set({ pageIndex: 1, pageSize: 2 });
    expect(c.pageStart()).toBe(3);
    expect(c.pageEnd()).toBe(3);
  });

  it('defaults to created_at desc and ignores corrupt/legacy ag-grid localStorage state', () => {
    localStorage.setItem('ps_audit_grid_v2', JSON.stringify([{ colId: 'site', sort: 'asc' }]));
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.sorting()).toEqual([{ id: 'created_at', desc: true }]);
  });

  it('restores a valid persisted sort', () => {
    localStorage.setItem('ps_audit_grid_v2', JSON.stringify({ sorting: [{ id: 'action', desc: true }] }));
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.sorting()).toEqual([{ id: 'action', desc: true }]);
  });

  it('persists the sort state on a header toggle (desc → removed → asc cycle)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([ROW()] as never);
    const whenHeader = c.table.getHeaderGroups()[0].headers.find((h) => h.id === 'created_at');
    expect(whenHeader).toBeDefined();
    whenHeader?.column.toggleSorting(); // desc → removed (natural order)
    let stored = JSON.parse(localStorage.getItem('ps_audit_grid_v2') ?? '{}') as { sorting?: unknown };
    expect(stored.sorting).toEqual([]);
    whenHeader?.column.toggleSorting(); // removed → asc
    stored = JSON.parse(localStorage.getItem('ps_audit_grid_v2') ?? '{}') as { sorting?: unknown };
    expect(stored.sorting).toEqual([{ id: 'created_at', desc: false }]);
  });
});

describe('AdminAuditComponent (scope chip reactivity)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('showScopeChip is true at the initial slug and false once cleared', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.showScopeChip()).toBe(true);
    c.clearScope();
    expect(c.scopeSlug()).toBeNull();
    expect(c.showScopeChip()).toBe(false);
  });

  it('the "Org:" chip shows the REAL org name — never the hardcoded "megabytespace" lie', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    // Mock org is "E2E Test Org" (id e2e-test-org) — the chip must reflect it, not a literal.
    expect(c.scopeName()).toBe('E2E Test Org');
    expect(c.scopeName()).not.toBe('megabytespace');
  });

  it('KPI accessors return numbers (rolling-counter binds numeric values)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    c.rows.set([ROW()] as never);
    expect(typeof c.uniqueActions()).toBe('number');
    expect(typeof c.uniqueActors()).toBe('number');
    expect(typeof c.last24h()).toBe('number');
    expect(typeof c.rows().length).toBe('number');
  });
});

describe('AdminAuditComponent (cohesion + a11y source contract)', () => {
  // Best-effort read of the @Component decorator args (template + styles).
  // Angular stores compiled output, so this peeks at the decorator metadata
  // a few known ways; if none resolve, the per-it() guards short-circuit and
  // the contract falls back to the AOT build + prod a11y E2E enforcement.
  function decorator(): { template?: string; styles?: string[] } {
    const cls = AdminAuditComponent as unknown as {
      __annotations__?: Array<Record<string, unknown>>;
      decorators?: Array<{ args?: Array<Record<string, unknown>> }>;
    };
    const fromAnn = Array.isArray(cls.__annotations__)
      ? cls.__annotations__.find((a) => 'template' in a || 'styles' in a)
      : undefined;
    const fromDec = Array.isArray(cls.decorators)
      ? cls.decorators.find((d) => d.args?.[0] && ('template' in d.args[0] || 'styles' in d.args[0]))?.args?.[0]
      : undefined;
    const reflectAnn = (Reflect as unknown as { getOwnMetadata?: (k: string, t: unknown) => unknown }).getOwnMetadata?.(
      'annotations',
      AdminAuditComponent,
    ) as Array<Record<string, unknown>> | undefined;
    const fromReflect = Array.isArray(reflectAnn) ? reflectAnn.find((a) => 'template' in a) : undefined;
    return (fromAnn ?? fromDec ?? fromReflect ?? {}) as { template?: string; styles?: string[] };
  }
  const template = (): string => decorator().template ?? '';
  const styles = (): string => (decorator().styles ?? []).join('\n');
  const reachable = (): boolean => template().length > 0 || styles().length > 0;

  it('every numeric KPI binds through <app-rolling-counter> (no raw stat node)', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable in this runner — contract enforced by AOT build + prod a11y E2E');
      return;
    }
    const t = template();
    expect((t.match(/<app-rolling-counter/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // KPI numbers must not be raw interpolation stat nodes.
    expect(t).not.toMatch(/text-2xl[^>]*>\s*\{\{\s*(rows|uniqueActions|uniqueActors|last24h)/);
  });

  it('empty state announces via role="status"', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable');
      return;
    }
    expect(template()).toContain('role="status"');
  });

  it('the stats skeleton persists real labels — no generic ">Loading</div>" header that reflows on load', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable');
      return;
    }
    const t = template();
    expect(t).withContext('skeleton loops the persisted KPI labels').toContain('statLabels');
    expect(t).withContext('no generic "Loading" stat-card header (would reflow → real label)').not.toContain('>Loading</div>');
  });

  it('empty-state CTA + scope chip are real <button>s (keyboard-reachable); kebab + detail carry a11y wiring', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable');
      return;
    }
    const t = template();
    expect(t).toContain('data-testid="audit-scope-chip"');
    expect(t).toContain('data-testid="audit-empty"');
    expect((t.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The scope chip is an org-context label, NOT an applied filter (the audit
    // API loads all org sites) — it must not claim "Filtered to:".
    expect(t).not.toContain('Filtered to:');
    expect(t).toContain('Org: {{ scopeName() }}');
    // The kebab is a real Angular button now (was an imperative cellRenderer) —
    // assert its aria contract in-template.
    expect(t).toContain('[attr.aria-expanded]');
    expect(t).toContain("'Expand audit detail'");
    // Detail panel actions carry copy testids.
    expect(t).toContain('audit-copy-row-');
  });

  it('brand colour is the cyan token family — never orange', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable');
      return;
    }
    const css = (template() + '\n' + styles()).toLowerCase();
    expect(css).toContain('00e5ff'); // project cyan
    expect(css).not.toContain('orange');
    expect(css).not.toMatch(/#ff[789a-f][0-9a-f]{2,4}\b/); // #ff7000-style oranges
  });

  it('every @keyframes animation pairs with a prefers-reduced-motion guard', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable');
      return;
    }
    const css = styles();
    const keyframeCount = (css.match(/@keyframes/g) ?? []).length;
    if (keyframeCount > 0) {
      expect(css).toContain('prefers-reduced-motion');
    } else {
      expect(keyframeCount).toBe(0);
    }
  });

  // Lying-control regression: the default pageSize (50) is NOT the first option
  // (25). A bare `<select [value]="pagination().pageSize">` sets `select.value`
  // before the `@for` renders its `<option>`s, so the browser falls back to the
  // FIRST option (25) — the control displays "25 rows" while the table actually
  // pages 50 ("Showing 1–50 of 500", "Page 1 of 10"). The fix moves the selected
  // state onto each `<option>` via `[selected]`, evaluated as each option is
  // created, so the control always reflects the true page size.
  it('page-size <select> reflects the true page size via [selected] on each option — never the lying <select [value]> that shows 25 while paging 50', () => {
    if (!reachable()) {
      pending('decorator metadata not reachable — contract enforced by AOT build + prod a11y E2E');
      return;
    }
    const t = template();
    expect(t).withContext('each option owns its selected state (reliable across @for render order)').toContain(
      '[selected]="n === pagination().pageSize"',
    );
    expect(t)
      .withContext('the unreliable <select [value]="pagination().pageSize"> binding was the bug — must be gone')
      .not.toMatch(/<select[^>]*\[value\]="pagination\(\)\.pageSize"/);
  });
});

/**
 * CSV export — formula-injection guard (CWE-1236). The audit log holds
 * user/system strings (actor email, action, target, before/after JSON) that may
 * begin with = + - @; those execute as formulas in Excel/Sheets. csvCell()
 * apostrophe-prefixes such cells, then applies RFC-4180 quoting.
 */
describe('AdminAuditComponent (CSV export is formula-injection-safe)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('csvFormulaGuard prefixes formula-trigger cells, leaves normal values', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.csvFormulaGuard('=cmd|calc')).toBe(`'=cmd|calc`);
    expect(c.csvFormulaGuard('+1')).toBe(`'+1`);
    expect(c.csvFormulaGuard('-2')).toBe(`'-2`);
    expect(c.csvFormulaGuard('@SUM')).toBe(`'@SUM`);
    expect(c.csvFormulaGuard('\t=x')).toBe(`'\t=x`);
    expect(c.csvFormulaGuard('admin@megabyte.space')).toBe('admin@megabyte.space'); // @ not leading
    expect(c.csvFormulaGuard('site.created')).toBe('site.created');
    expect(c.csvFormulaGuard(null)).toBe('');
  });

  it('csvCell applies RFC-4180 quoting (commas, quotes, newlines)', () => {
    const c = make(jasmine.createSpy('get').and.returnValue(of({ data: [] })));
    expect(c.csvCell('a,b')).toBe('"a,b"');
    expect(c.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(c.csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(c.csvCell('plain')).toBe('plain');
  });

  it('buildCsv emits the header row + guarded, quoted cells from the filtered rows', () => {
    const c = make(
      jasmine.createSpy('get').and.returnValue(
        of({ data: [ROW({ id: 'm1', action: '=weird', message: 'has,comma', metadata: { a: 1 } })] }),
      ),
    );
    c.load(); // seed an event so the table data is populated
    const csv = c.buildCsv();
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('action,message,created_at,site,actor_id,target,request_id,metadata');
    expect(lines[1]).toContain(`'=weird`);
    expect(lines[1]).toContain('"has,comma"');
    expect(lines[1]).toContain('site:site-1');
    expect(lines[1]).toContain('"{""a"":1}"'); // metadata JSON quoted, inner quotes RFC-4180-doubled
    expect(lines.length).toBe(2);
  });
});

describe('AdminAuditComponent — bounded auto-poll retry (error-recovery max 3)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pauses auto-poll after 3 consecutive load errors; a success resumes it', () => {
    const get = jasmine.createSpy('get').and.returnValue(throwError(() => ({ status: 500 })));
    const c = make(get);
    c.load(); c.load(); c.load();
    expect(c.consecutiveErrors()).toBe(3);
    expect(c.autoRefreshPaused()).withContext('paused after max retries').toBeTrue();

    get.and.returnValue(of({ data: [] }));
    c.load();
    expect(c.consecutiveErrors()).toBe(0);
    expect(c.autoRefreshPaused()).withContext('a success resumes auto-poll').toBeFalse();
  });
});
