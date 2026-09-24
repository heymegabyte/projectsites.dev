import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError, Subject } from 'rxjs';
import { signal } from '@angular/core';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { AdminSiteDetailComponent } from './site-detail.component';
import { RevealDirective } from '../../../directives/reveal.directive';
import { ApiService } from '../../../services/api.service';
import { ConfirmService } from '../../../services/confirm.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';

/**
 * Stub AdminStateService exposing only the `isSuperAdmin` signal the component reads.
 * The SQL console (tab + panel + runSql) is gated on it — pass `true` for the specs
 * that exercise the SQL surface, `false` to assert the tab is hidden for a site owner.
 */
function superAdminState(isSuperAdmin: boolean): Partial<AdminStateService> {
  return { isSuperAdmin: signal(isSuperAdmin) } as Partial<AdminStateService>;
}

/**
 * First coverage for the Site Detail tabs surface (untested):
 *  - filteredLogs() filters by level + search
 *  - setTab() switches the active tab
 *  - runSql(): blank query is a no-op (no POST); a result populates sqlResult + clears error;
 *    a failure sets sqlError (read-only D1 console — server enforces read-only, client surfaces errors)
 * overrideComponent strips the template so the log-tail/snapshot effects don't auto-fire;
 * the route paramMap stub drives the initial site id.
 */
function make(
  post = jasmine.createSpy('post').and.returnValue(of({ ok: true, columns: ['id'], rows: [{ id: 1 }], duration_ms: 5 })),
  isSuperAdmin = true, // SQL console is super-admin-gated; default true so the SQL specs run it
): {
  c: AdminSiteDetailComponent;
  post: jasmine.Spy;
} {
  const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' } })), post };
  TestBed.configureTestingModule({
    imports: [AdminSiteDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AdminStateService, useValue: superAdminState(isSuperAdmin) },
      { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
    ],
  });
  TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
  return { c: TestBed.createComponent(AdminSiteDetailComponent).componentInstance, post };
}

describe('AdminSiteDetailComponent (tabs + logs + SQL console)', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  it('filteredLogs applies the level filter and the search query', () => {
    const { c } = make();
    c.logs.set([
      { ts: 1, level: 'info', message: 'started build' },
      { ts: 2, level: 'error', message: 'build FAILED' },
      { ts: 3, level: 'info', message: 'served page' },
    ] as never);
    c.logLevel.set('error');
    expect(c.filteredLogs().length).toBe(1);
    c.logLevel.set('all');
    c.logSearch.set('build');
    expect(c.filteredLogs().map((r) => r.message)).toEqual(['started build', 'build FAILED']);
  });

  // The logs @empty message must be filter-aware: never claim "No logs yet"
  // while logs exist but a level/search filter hides them all.
  it('logsEmptyText says "no match" when a filter hides existing logs, "no logs yet" when truly empty', () => {
    const { c } = make();
    c.logs.set([]); c.logLevel.set('all'); c.logSearch.set('');
    expect(c.logsEmptyText()).withContext('truly empty').toContain('No logs yet');
    c.logs.set([{ ts: 1, level: 'info', message: 'served page' }] as never);
    c.logLevel.set('error'); // no error rows → filtered to zero, but logs exist
    expect(c.logsEmptyText()).withContext('level filter hides all → no-match').toContain('No logs match');
    c.logLevel.set('all'); c.logSearch.set('zzz-no-such-line');
    expect(c.logsEmptyText()).withContext('search hides all → no-match').toContain('No logs match');
    c.logSearch.set('');
    expect(c.logsEmptyText()).withContext('back to no filter → no-logs-yet copy').toContain('No logs yet');
  });

  // The snapshots load-error now renders through the shared <app-error-card>, which
  // surfaces a copyable worker request_id — capture it from the failed response so
  // a stuck operator can hand it to support.
  it('loadSnapshots captures the worker request_id into snapshotsErrorRef on a hard failure', () => {
    const { c } = make();
    (TestBed.inject(ApiService).get as jasmine.Spy).and.returnValue(
      throwError(() => ({ status: 500, error: { error: { request_id: 'req-snap-9' } } })),
    );
    c.loadSnapshots('site-1');
    expect(c.snapshotsError()).toBeTruthy();
    expect(c.snapshotsErrorRef()).toBe('req-snap-9');
  });

  it('loadSnapshots leaves snapshotsErrorRef empty on a shapeless 200 (no err) + clears on a healthy reload', () => {
    const { c } = make();
    const get = TestBed.inject(ApiService).get as jasmine.Spy;
    get.and.returnValue(of({})); // stale SPA-HTML 200 → error set, but no err object
    c.loadSnapshots('site-1');
    expect(c.snapshotsError()).toBeTruthy();
    expect(c.snapshotsErrorRef()).toBe('');
    get.and.returnValue(of({ data: [] })); // worker returns { data: SnapshotRow[] }
    c.loadSnapshots('site-1');
    expect(c.snapshotsError()).toBeNull();
    expect(c.snapshotsErrorRef()).toBe('');
  });

  it('setTab switches the active tab', () => {
    const { c } = make();
    expect(c.tab()).toBe('logs');
    c.setTab('sql');
    expect(c.tab()).toBe('sql');
  });

  it('runSql is a no-op on a blank query (no POST)', () => {
    const { c, post } = make();
    c.sqlQuery.set('   ');
    c.runSql();
    expect(post).not.toHaveBeenCalled();
  });

  it('runSql posts the query and populates the result, clearing error + running', () => {
    const { c, post } = make();
    c.sqlQuery.set('SELECT * FROM sites');
    c.runSql();
    expect(post).toHaveBeenCalled();
    expect(post.calls.mostRecent().args[0]).toContain('/sql/exec');
    expect(c.sqlResult()?.rows.length).toBe(1);
    expect(c.sqlError()).toBeNull();
    expect(c.sqlRunning()).toBe(false);
  });

  it('runSql surfaces D1 query cost (rows read/written + D1 duration) into the result', () => {
    const post = jasmine.createSpy('post').and.returnValue(
      of({ ok: true, columns: ['id'], rows: [{ id: 1 }], duration_ms: 8, rows_read: 12000, rows_written: 0, d1_duration_ms: 6 }),
    );
    const { c } = make(post);
    c.sqlQuery.set('SELECT * FROM big_table');
    c.runSql();
    const r = c.sqlResult()!;
    expect(r.rows_read).toBe(12000);
    expect(r.rows_written).toBe(0);
    expect(r.d1_duration_ms).toBe(6);
    expect(c.isExpensiveScan(r)).toBeTrue(); // 12,000 read > 10,000 threshold → flagged
  });

  it('isExpensiveScan flags only a large REPORTED rows_read (never a null or small one)', () => {
    const { c } = make();
    const base = { columns: [], rows: [], duration_ms: 0, rows_written: 0, d1_duration_ms: 1 };
    expect(c.isExpensiveScan({ ...base, rows_read: 12000 })).toBeTrue();
    expect(c.isExpensiveScan({ ...base, rows_read: 500 })).toBeFalse();
    expect(c.isExpensiveScan({ ...base, rows_read: null })).toBeFalse(); // null = not reported, not a fake 0
  });

  it('explainSql posts EXPLAIN QUERY PLAN (semicolon stripped) and populates the plan detail lines', () => {
    const post = jasmine.createSpy('post').and.returnValue(
      of({
        ok: true,
        columns: ['id', 'parent', 'notused', 'detail'],
        rows: [
          { id: 2, parent: 0, notused: 0, detail: 'SCAN visitor_events' },
          { id: 3, parent: 0, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
        ],
      }),
    );
    const { c } = make(post);
    c.sqlQuery.set('SELECT * FROM visitor_events ORDER BY created_at;');
    c.explainSql();
    expect(post).toHaveBeenCalled();
    expect((post.calls.mostRecent().args[1] as { query: string }).query).toBe(
      'EXPLAIN QUERY PLAN SELECT * FROM visitor_events ORDER BY created_at',
    );
    expect(c.explainPlan()).toEqual(['SCAN visitor_events', 'USE TEMP B-TREE FOR ORDER BY']);
    expect(c.explainRunning()).toBeFalse();
  });

  it('planHint warns on a full-table scan / temp-B-tree and approves an index plan', () => {
    const { c } = make();
    c.explainPlan.set(['SCAN visitor_events']);
    expect(c.planHint()?.level).toBe('warn');
    expect(c.planHint()?.text).toContain('index');
    c.explainPlan.set(['SEARCH visitor_events USING INDEX idx_site (site_id=?)']);
    expect(c.planHint()?.level).toBe('ok');
    c.explainPlan.set(null);
    expect(c.planHint()).toBeNull();
  });

  it('explainSql surfaces an EXPLAIN error into the shared error surface without throwing', () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ ok: false, error: 'near "SELCT": syntax error' }));
    const { c } = make(post);
    c.sqlQuery.set('SELCT 1');
    c.explainSql();
    expect(c.sqlError()).toContain('syntax error');
    expect(c.explainPlan()).toBeNull();
  });

  it('explainSqlError maps common SQLite/D1 errors to plain language, null for unknown', () => {
    const { c } = make();
    expect(c.explainSqlError('no such table: visitor_eventz')).toContain("doesn't exist");
    expect(c.explainSqlError('no such table: visitor_eventz')).toContain('visitor_eventz');
    expect(c.explainSqlError('no such column: created')).toContain('column "created"');
    expect(c.explainSqlError('no such function: NOW')).toContain('standard SQLite functions');
    expect(c.explainSqlError('near "FROM": syntax error')).toContain('near "FROM"');
    expect(c.explainSqlError('unrecognized token: "@"')).toContain('Unrecognized token');
    expect(c.explainSqlError('UNIQUE constraint failed: users.email')).toContain('already exists');
    // Unknown error → null so the UI shows ONLY the raw error (never hidden).
    expect(c.explainSqlError('some totally novel D1 internal error')).toBeNull();
    expect(c.explainSqlError('')).toBeNull();
  });

  // The Run button had no [disabled] + runSql had no in-flight guard, so a slow
  // query let repeated clicks pile up concurrent /sql/exec POSTs (wasteful +
  // flickering results). sqlRunning() now guards re-entry.
  it('runSql fires only ONE POST while a query is in flight (no pile-up)', () => {
    const inflight = new Subject<unknown>(); // never completes → stays running
    const post = jasmine.createSpy('post').and.returnValue(inflight.asObservable());
    const { c } = make(post);
    c.sqlQuery.set('SELECT * FROM sites');
    c.runSql();
    c.runSql(); // second click while the first is still running
    expect(post).toHaveBeenCalledTimes(1);
    expect(c.sqlRunning()).toBeTrue();
  });

  it('runSql surfaces a query error without throwing (server read-only/validation errors)', () => {
    // Uses a SELECT (passes the client read-only guard) that the SERVER rejects,
    // so this still covers the server-error surface path.
    const { c } = make(jasmine.createSpy('post').and.returnValue(throwError(() => ({ error: { error: { message: 'no such table: ghost' } } }))));
    c.sqlQuery.set('SELECT * FROM ghost');
    c.runSql();
    expect(c.sqlError()).toContain('no such table');
    expect(c.sqlRunning()).toBe(false);
  });

  // Client-side read-only guard: a leading write/DDL keyword is blocked BEFORE the
  // POST — instant clear feedback + no wasted round-trip (the server is still the
  // real boundary). Defense-in-depth on a power-tool that could tempt a DROP.
  it('runSql BLOCKS a leading write statement client-side (no POST, clear read-only error)', () => {
    const { c, post } = make();
    for (const q of ['DELETE FROM sites', 'drop table users', '  UPDATE sites SET x=1', '-- note\nINSERT INTO t VALUES(1)']) {
      c.sqlError.set(null);
      c.sqlQuery.set(q);
      c.runSql();
      expect(post).withContext(`must not POST a write query: ${q}`).not.toHaveBeenCalled();
      expect(c.sqlError()).withContext(`read-only message for: ${q}`).toContain('read-only');
    }
  });

  it('runSql ALLOWS read queries (SELECT / WITH / EXPLAIN) through to the server', () => {
    for (const q of ['SELECT 1', 'with t as (select 1) select * from t', 'EXPLAIN QUERY PLAN SELECT 1']) {
      const { c, post } = make();
      c.sqlQuery.set(q);
      c.runSql();
      expect(post).withContext(`read query must POST: ${q}`).toHaveBeenCalled();
      TestBed.resetTestingModule();
    }
  });

  it('a SELECT with the word "update" inside it is NOT a false positive', () => {
    const { c, post } = make();
    c.sqlQuery.set("SELECT * FROM sites WHERE note = 'please update later'");
    c.runSql();
    expect(post).withContext('only the LEADING keyword gates — inner text is fine').toHaveBeenCalled();
    expect(c.sqlError()).toBeNull();
  });

  // ── Saved queries + clickable history recall (curated one-click reuse) ──
  it('saveCurrentQuery stores the current editor query under a name, then clears the name field', () => {
    const { c } = make();
    c.sqlQuery.set('SELECT * FROM sites');
    c.saveName.set('all sites');
    c.saveCurrentQuery();
    expect(c.savedQueries()).toEqual([{ name: 'all sites', sql: 'SELECT * FROM sites' }]);
    expect(c.saveName()).withContext('name field cleared after save').toBe('');
  });

  it('saveCurrentQuery is a no-op when the query OR the name is blank', () => {
    const { c } = make();
    c.sqlQuery.set('SELECT 1');
    c.saveName.set('   ');
    c.saveCurrentQuery();
    expect(c.savedQueries()).withContext('blank name → no save').toEqual([]);
    c.sqlQuery.set('   ');
    c.saveName.set('x');
    c.saveCurrentQuery();
    expect(c.savedQueries()).withContext('blank query → no save').toEqual([]);
  });

  it('saveCurrentQuery dedupes by name (a re-save under the same name updates the SQL)', () => {
    const { c } = make();
    c.sqlQuery.set('SELECT 1');
    c.saveName.set('q');
    c.saveCurrentQuery();
    c.sqlQuery.set('SELECT 2');
    c.saveName.set('q');
    c.saveCurrentQuery();
    expect(c.savedQueries()).toEqual([{ name: 'q', sql: 'SELECT 2' }]);
  });

  it('loadQuery fills the editor WITHOUT running (no POST) — recall lets the user review, then Run', () => {
    const { c, post } = make();
    c.loadQuery('SELECT * FROM audit_logs');
    expect(c.sqlQuery()).toBe('SELECT * FROM audit_logs');
    expect(post).withContext('recall never auto-runs a query').not.toHaveBeenCalled();
  });

  it('deleteSavedQuery removes a saved query by name', () => {
    const { c } = make();
    c.sqlQuery.set('SELECT 1');
    c.saveName.set('a');
    c.saveCurrentQuery();
    c.sqlQuery.set('SELECT 2');
    c.saveName.set('b');
    c.saveCurrentQuery();
    c.deleteSavedQuery('a');
    expect(c.savedQueries().map((q) => q.name)).toEqual(['b']);
  });

  it('saved queries persist to (and delete from) the per-site localStorage key', () => {
    const { c } = make();
    c.siteId.set('site-persist');
    c.sqlQuery.set('SELECT * FROM sites');
    c.saveName.set('all');
    c.saveCurrentQuery();
    const raw = localStorage.getItem('ps_sql_saved_site-persist');
    expect(raw).withContext('persisted under the per-site key').toBeTruthy();
    expect(JSON.parse(raw!)).toEqual([{ name: 'all', sql: 'SELECT * FROM sites' }]);
    c.deleteSavedQuery('all');
    expect(JSON.parse(localStorage.getItem('ps_sql_saved_site-persist')!))
      .withContext('delete persists too')
      .toEqual([]);
  });

  // ── Rollback must NOT claim a false success on failure (lying-UI guard) ──
  it('confirmRollback shows the rolled-back version + no error on success', () => {
    const okPost = jasmine.createSpy('post').and.returnValue(of({ ok: true, snapshot_name: 'v3' }));
    const { c } = make(okPost);
    c.pendingRollback.set({ id: 'snap-1', snapshot_name: 'v3' } as never);
    c.confirmRollback();
    expect(c.rollbackResult()).toBe('v3');
    expect(c.rollbackError()).toBeNull();
    expect(c.pendingRollback()).toBeNull();
    // {silent}: the inline rollback-error panel is the sole failure surface — no
    // generic ApiService double-toast over it.
    expect(okPost.calls.mostRecent().args[2]).toEqual({ silent: true });
  });

  it('confirmRollback surfaces an error + does NOT claim success when the rollback fails', () => {
    const failPost = jasmine
      .createSpy('post')
      .and.returnValue(throwError(() => ({ error: { error: { message: 'rollback boom' } } })));
    const { c } = make(failPost);
    c.pendingRollback.set({ id: 'snap-1', snapshot_name: 'v3' } as never);
    c.confirmRollback();
    expect(c.rollbackResult()).withContext('no false success message').toBeNull();
    expect(c.rollbackError()).toContain('boom');
    expect(c.pendingRollback()).withContext('dialog closed').toBeNull();
  });
});

describe('AdminSiteDetailComponent (cinematic entrance — matches sibling sections)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the root section animates in on first paint (animate-fade-in), like every other admin section', () => {
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' }, columns: [], rows: [], logs: [], snapshots: [] })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    const root = (f.nativeElement as HTMLElement).querySelector('.site-detail');
    expect(root).withContext('site-detail root renders').not.toBeNull();
    expect(root!.classList.contains('animate-fade-in')).withContext('root must animate in (opacity-only, reduced-motion-safe) like sibling sections').toBe(true);
  });

  it('the {slug}.projectsites.dev subtitle is a clickable external link to the live site', () => {
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' }, columns: [], rows: [], logs: [], snapshots: [] })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    const link = (f.nativeElement as HTMLElement).querySelector('a.site-detail__subtitle--link') as HTMLAnchorElement | null;
    expect(link).withContext('the site URL is an <a>, not dead text').not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://s.projectsites.dev');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
  });

  it('stagger-reveals the header, tablist nav, and active panel via appReveal (first-paint cohesion)', () => {
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' }, columns: [], rows: [], logs: [], snapshots: [] })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    // header + tablist nav + the active (logs) panel each carry the directive.
    expect(f.debugElement.queryAll(By.directive(RevealDirective)).length)
      .withContext('header + nav + active panel stagger-reveal').toBeGreaterThanOrEqual(3);
    expect(host.querySelector('.site-detail__head')?.hasAttribute('appReveal'))
      .withContext('the header carries appReveal').toBe(true);
    expect(host.querySelector('.site-detail__tabs')?.hasAttribute('appReveal'))
      .withContext('the tablist nav carries appReveal').toBe(true);
  });

  // The Logs + Snapshots tab empties used bare muted text; the cockpit standard
  // for a sub-panel empty is the cyan-glyph <app-mini-empty> primitive.
  function renderEmpty(): import('@angular/core/testing').ComponentFixture<AdminSiteDetailComponent> {
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' }, columns: [], rows: [], logs: [], snapshots: [] })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    return f;
  }

  it('the Logs tab empty uses the cyan-glyph <app-mini-empty> (not bare muted text)', () => {
    const f = renderEmpty();
    const tail = (f.nativeElement as HTMLElement).querySelector('[data-testid="site-logs-tail"]');
    expect(tail?.querySelector('app-mini-empty')).withContext('cyan-glyph empty primitive in the Logs tab').not.toBeNull();
    expect(tail?.querySelector('p.muted')).withContext('no bare muted "No logs yet." text').toBeNull();
  });

  it('the Snapshots tab empty uses the cyan-glyph <app-mini-empty>', () => {
    const f = renderEmpty();
    f.componentInstance.setTab('snapshots');
    f.detectChanges();
    const list = (f.nativeElement as HTMLElement).querySelector('[data-testid="site-snapshots-list"]');
    expect(list?.querySelector('app-mini-empty')).withContext('cyan-glyph empty primitive in the Snapshots tab').not.toBeNull();
  });

  it('never renders a bare ".projectsites.dev" subtitle when the site fails to resolve (falls back to the URL slug)', () => {
    // GET /sites/:id can 200 with { site: null } (id not fully resolvable) — site()
    // stays null and the header used to show a broken bare ".projectsites.dev".
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ site: null })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    const sub = (f.nativeElement as HTMLElement).querySelector('.site-detail__subtitle');
    expect(sub).not.toBeNull();
    const txt = (sub!.textContent ?? '').trim();
    expect(txt).withContext('subtitle must not be a bare orphaned TLD').not.toBe('.projectsites.dev');
    expect(txt).withContext('falls back to the URL slug so the host is meaningful').toContain('site-1');
  });

  // The h1 must identify WHICH site you're viewing. A site whose record has an
  // empty name used to render the generic literal "Site" (indistinguishable from
  // a failed load) — now it falls back to the slug, which is meaningful context.
  function renderWithSite(site: unknown): HTMLElement {
    TestBed.resetTestingModule();
    // The worker returns { data: { …, business_name } } and loadSite reads res.data.
    // This mock previously used the old { site } wrapper (with a `name` field), which
    // is exactly why the res.site-miss → h1-shows-UUID bug shipped green. Pass site
    // objects shaped like the real API (business_name, not name).
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: site })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'e2e-site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('h1 shows the site business name (from res.data.business_name) — never the raw UUID', () => {
    const el = renderWithSite({ id: 'b41e1eb9-e732-474b-9fc5-281ad4ef1ae2', slug: 'urban-fitness', business_name: 'Urban Fitness Co' });
    const h1 = el.querySelector('.site-detail__title')?.textContent?.trim();
    expect(h1).withContext('h1 maps data.business_name → name; res.site miss used to leave this the UUID').toBe('Urban Fitness Co');
    expect(h1).not.withContext('never renders the raw site UUID').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('h1 falls back to the slug (not the generic "Site") when the business name is empty', () => {
    const el = renderWithSite({ id: 'e2e-site-1', slug: 'urban-fitness', business_name: '' });
    const h1 = el.querySelector('.site-detail__title')?.textContent?.trim();
    expect(h1).withContext('a nameless site shows its slug, not an uninformative "Site"').toBe('urban-fitness');
    expect(h1).not.toBe('Site');
  });
});

/**
 * Disconnecting an integration is destructive (re-OAuth needed to restore). It
 * used a bespoke inline confirm <div> (custom modal — drift per the
 * one-dialog-primitive rule, no focus-trap/Esc/accessible-name). Now it routes
 * through the shared ConfirmService (branded CDK dialog) and the DELETE is
 * {silent} so a failure shows ONLY the specific 'Could not disconnect' toast.
 */
describe('AdminSiteDetailComponent (integration disconnect — confirm-gated via ConfirmService)', () => {
  function build(confirmResult: boolean, del = jasmine.createSpy('delete').and.returnValue(of({ ok: true }))): {
    c: AdminSiteDetailComponent; del: jasmine.Spy; confirm: jasmine.Spy; toastErr: jasmine.Spy;
  } {
    const confirm = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
    const toastErr = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ data: { id: 's1', slug: 's', business_name: 'S' } }), post: () => of({}), delete: del } },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 's1' }), queryParamMap: of({ get: () => null }) } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: ToastService, useValue: { error: toastErr, success: () => 0, info: () => 0, warning: () => 0 } },
      ],
    });
    TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminSiteDetailComponent).componentInstance, del, confirm, toastErr };
  }
  const PROV = { key: 'mailchimp', name: 'Mailchimp', status: 'connected' } as never;
  afterEach(() => TestBed.resetTestingModule());

  it('does NOT disconnect when the confirm is cancelled (no DELETE)', async () => {
    const { c, del, confirm } = build(false);
    await c.onDisconnect(PROV);
    expect(confirm).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('disconnects via the shared ConfirmService — DELETE is {silent} (no generic double-toast)', async () => {
    const { c, del, confirm } = build(true);
    await c.onDisconnect(PROV);
    expect(confirm).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('/sites/s1/integration-providers/mailchimp', { silent: true });
  });

  it('a failed disconnect surfaces the specific error + does NOT optimistically flip the chip', async () => {
    const { c, toastErr } = build(true, jasmine.createSpy('delete').and.returnValue(throwError(() => ({ status: 500 }))));
    c.integrations.set([{ key: 'mailchimp', name: 'Mailchimp', status: 'connected' } as never]);
    await c.onDisconnect(PROV);
    expect(toastErr).toHaveBeenCalled();
    expect(c.integrations()[0].status).withContext('no lying optimistic flip on failure').toBe('connected');
  });
});

/**
 * Snapshot rollback OVERWRITES the live production site — the single most
 * destructive admin action. It used a bespoke inline confirm <div> (custom-modal
 * drift; and it lost its styling when the shared .confirm-dialog CSS was removed).
 * Now onRollbackClick gates through the shared ConfirmService (branded danger
 * dialog) before confirmRollback() fires the POST. The existing confirmRollback()
 * specs above still pass (they call it directly — the POST path is unchanged).
 */
describe('AdminSiteDetailComponent (snapshot rollback — confirm-gated, most destructive)', () => {
  function build(confirmResult: boolean): { c: AdminSiteDetailComponent; post: jasmine.Spy; confirm: jasmine.Spy } {
    const post = jasmine.createSpy('post').and.returnValue(of({ ok: true, snapshot_name: 'v3' }));
    const confirm = jasmine.createSpy('confirm').and.resolveTo(confirmResult);
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ data: { id: 's1', slug: 's', business_name: 'S' } }), post, delete: () => of({}) } },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 's1' }), queryParamMap: of({ get: () => null }) } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
      ],
    });
    TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminSiteDetailComponent).componentInstance, post, confirm };
  }
  const SNAP = { id: 'snap-9', snapshot_name: 'launch-v3' } as never;
  afterEach(() => TestBed.resetTestingModule());

  it('does NOT roll back when the confirm is cancelled (no POST, no pending state left dangling)', async () => {
    const { c, post, confirm } = build(false);
    await c.onRollbackClick(SNAP);
    expect(confirm).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(c.pendingRollback()).toBeNull();
  });

  it('rolls back via ConfirmService — POST fires to the rollback endpoint on confirm', async () => {
    const { c, post, confirm } = build(true);
    await c.onRollbackClick(SNAP);
    expect(confirm).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/sites/s1/snapshots/snap-9/rollback', {}, { silent: true });
    expect(c.rollbackResult()).toBe('v3');
  });
});

describe('AdminSiteDetailComponent (SQL starter queries)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('useSqlStarter fills the editor + runs the query (read-only POST to /sql/exec)', () => {
    const { c, post } = make();
    c.useSqlStarter("SELECT name FROM sqlite_master WHERE type='table'");
    expect(c.sqlQuery()).toContain('sqlite_master');
    expect(post).toHaveBeenCalledWith('/sites/site-1/sql/exec', { query: "SELECT name FROM sqlite_master WHERE type='table'" });
  });

  it('every starter query is read-only (passes the WRITE_LEAD client guard → fires a POST, no sqlError)', () => {
    const { c, post } = make();
    for (const st of c.sqlStarters) {
      post.calls.reset();
      c.sqlError.set('stale');
      c.useSqlStarter(st.query);
      expect(post).withContext(`${st.label} should be read-only + run`).toHaveBeenCalled();
      expect(c.sqlError()).withContext(`${st.label} must not trip the read-only guard`).toBeNull();
    }
  });
});

describe('AdminSiteDetailComponent (SQL result Copy JSON)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('copySqlResult writes the rows as JSON to the clipboard + flips the copied flag', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { c } = make();
    const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    c.copySqlResult({ columns: ['id', 'name'], rows, duration_ms: 3 });
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(rows, null, 2));
    await Promise.resolve();
    expect(c.sqlCopied()).toBeTrue();
  });

  it('downloadSqlCsv / downloadSqlJson trigger a file download with the correct content type', () => {
    const blobs: Blob[] = [];
    spyOn(URL, 'createObjectURL').and.callFake((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    });
    spyOn(URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click'); // never actually navigate in the test
    const { c } = make();
    const r = { columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], duration_ms: 3 };
    c.downloadSqlCsv(r);
    c.downloadSqlJson(r);
    expect(blobs.length).withContext('both downloads fired').toBe(2);
    expect(blobs[0].type).withContext('CSV mime').toContain('csv');
    expect(blobs[1].type).withContext('JSON mime').toContain('json');
  });
});

describe('AdminSiteDetailComponent (SQL result row cap — perf)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('cappedRows renders at most sqlRenderCap rows (full data stays in the result for Copy JSON)', () => {
    const { c } = make();
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const r = { columns: ['id'], rows: big, duration_ms: 1 };
    expect(c.sqlRenderCap).toBe(200);
    expect(c.cappedRows(r).length).toBe(200);
    expect(r.rows.length).withContext('underlying result untouched — Copy JSON exports all').toBe(500);
  });

  it('cappedRows returns all rows when under the cap', () => {
    const { c } = make();
    const r = { columns: ['id'], rows: [{ id: 1 }, { id: 2 }], duration_ms: 1 };
    expect(c.cappedRows(r).length).toBe(2);
  });
});

describe('AdminSiteDetailComponent (paste-key save — no silent failure)', () => {
  function build(post: jasmine.Spy): { c: AdminSiteDetailComponent; toastErr: jasmine.Spy; toastOk: jasmine.Spy } {
    const toastErr = jasmine.createSpy('error');
    const toastOk = jasmine.createSpy('success');
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ data: { id: 's1', slug: 's', business_name: 'S' }, providers: [] }), post, delete: () => of({}) } },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 's1' }), queryParamMap: of({ get: () => null }) } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: toastErr, success: toastOk, info: () => 0, warning: () => 0 } },
      ],
    });
    TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
    return { c: TestBed.createComponent(AdminSiteDetailComponent).componentInstance, toastErr, toastOk };
  }
  const PROV = { key: 'mailchimp', name: 'Mailchimp', status: 'disconnected' } as never;
  afterEach(() => TestBed.resetTestingModule());

  it('on a FAILED key save: keeps the form open, keeps the typed key, toasts a specific error (no silent close)', () => {
    const { c, toastErr } = build(jasmine.createSpy('post').and.returnValue(throwError(() => ({ status: 400 }))));
    c.pasteKeyOpen.set('mailchimp');
    c.pasteKeyValue.set('bad-key');
    c.submitPasteKey(PROV);
    expect(toastErr).toHaveBeenCalled();
    expect(c.pasteKeyOpen()).withContext('form stays open so the user can fix + retry').toBe('mailchimp');
    expect(c.pasteKeyValue()).withContext('typed key preserved').toBe('bad-key');
    expect(c.pasteKeySaving()).toBeFalse();
  });

  it('on a SUCCESSFUL save: closes the form, clears the key, toasts success', () => {
    const { c, toastOk } = build(jasmine.createSpy('post').and.returnValue(of({ ok: true })));
    c.pasteKeyOpen.set('mailchimp');
    c.pasteKeyValue.set('good-key');
    c.submitPasteKey(PROV);
    expect(toastOk).toHaveBeenCalledWith('Connected Mailchimp');
    expect(c.pasteKeyOpen()).toBeNull();
    expect(c.pasteKeyValue()).toBe('');
  });

  it('posts {silent:true} (its own toasts are the sole feedback) + guards double-submit', () => {
    const gate = new Subject<unknown>();
    const post = jasmine.createSpy('post').and.returnValue(gate);
    const { c } = build(post);
    c.pasteKeyValue.set('k');
    c.submitPasteKey(PROV);
    // The worker reads the site from `?site_id=` (query), not the body — without
    // it every paste-key connect 400'd "site_id required". The query param is the fix.
    expect(post).toHaveBeenCalledWith('/mcp/mailchimp/paste?site_id=s1', { api_key: 'k', site_id: 's1' }, { silent: true });
    c.submitPasteKey(PROV); // second click while in-flight
    expect(post).withContext('double-submit guarded').toHaveBeenCalledTimes(1);
  });
});

/**
 * Stale-route fake-empty guard — a STALE worker route can return a parseable
 * but shapeless 200 (SPA/marketing HTML, or `{}`). ApiService's 2xx→404 remap
 * only fires on an UNPARSEABLE body, so a shapeless 200 reaches the SUCCESS path.
 * The list-set handlers must guard `Array.isArray(...)` so a shapeless 200
 * degrades honestly (visible error / keep the fallback catalog) instead of
 * fake-emptying the list or crashing the @for on a non-array.
 */
describe('AdminSiteDetailComponent (stale-route shapeless 200 — no fake-empty / no crash)', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* */ } TestBed.resetTestingModule(); });

  function buildWithGet(getRes: unknown): AdminSiteDetailComponent {
    const api = {
      get: jasmine.createSpy('get').and.returnValue(of(getRes)),
      post: jasmine.createSpy('post').and.returnValue(of({ ok: true })),
      delete: () => of({}),
    };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
    return TestBed.createComponent(AdminSiteDetailComponent).componentInstance;
  }

  it('loadSnapshots: a shapeless 200 ({} — no snapshots array) sets a visible error and keeps the list a safe empty array (no crash, no fake "no snapshots yet")', () => {
    const c = buildWithGet({}); // stale route → parseable but no `snapshots`
    (c as unknown as { loadSnapshots: (id: string) => void }).loadSnapshots('site-1');
    expect(Array.isArray(c.snapshots())).withContext('list is always an array — @for never iterates a non-array').toBeTrue();
    expect(c.snapshots().length).toBe(0);
    expect(c.snapshotsError()).withContext('shapeless 200 surfaces an honest error, not a silent fake-empty').toBeTruthy();
  });

  it('loadSnapshots: a NON-ARRAY snapshots value (e.g. HTML coerced to a string) never reaches the signal (no @for crash)', () => {
    const c = buildWithGet({ data: '<html>not an array</html>' });
    (c as unknown as { loadSnapshots: (id: string) => void }).loadSnapshots('site-1');
    expect(Array.isArray(c.snapshots())).toBeTrue();
    expect(c.snapshots().length).toBe(0);
    expect(c.snapshotsError()).toBeTruthy();
  });

  it('loadSnapshots: a real array clears any prior error and populates the list', () => {
    const c = buildWithGet({ data: [{ id: 's1', snapshot_name: 'v1', kind: 'initial', created_at: 'x' }] });
    c.snapshotsError.set('stale error');
    (c as unknown as { loadSnapshots: (id: string) => void }).loadSnapshots('site-1');
    expect(c.snapshots().length).toBe(1);
    expect(c.snapshotsError()).withContext('a healthy load clears the prior error').toBeNull();
  });

  it('loadIntegrations: a NON-ARRAY providers value never reaches the @for — falls back to the default catalog', () => {
    const c = buildWithGet({ providers: 'not-an-array' }); // truthy `.length` would have slipped a string into the list
    (c as unknown as { loadIntegrations: (id: string) => void }).loadIntegrations('site-1');
    expect(Array.isArray(c.integrations())).toBeTrue();
    expect(c.integrations().length).withContext('falls back to the default provider catalog, not a coerced string').toBeGreaterThan(0);
    expect(c.integrations().every((p) => typeof p.key === 'string')).toBeTrue();
  });
});

/**
 * Rollback double-submit guard — onRollbackClick is async (awaits the confirm
 * dialog). The most destructive admin action must not let a rapid double-click
 * open TWO confirm dialogs (and risk firing two overwrites).
 */
describe('AdminSiteDetailComponent (rollback double-submit guard)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('a second Rollback click while the confirm is still pending opens only ONE dialog', async () => {
    let resolveConfirm!: (v: boolean) => void;
    const confirm = jasmine.createSpy('confirm').and.callFake(
      () => new Promise<boolean>((res) => { resolveConfirm = res; }),
    );
    const post = jasmine.createSpy('post').and.returnValue(of({ ok: true, snapshot_name: 'v3' }));
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ data: { id: 's1', slug: 's', business_name: 'S' } }), post, delete: () => of({}) } },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 's1' }), queryParamMap: of({ get: () => null }) } },
        { provide: ConfirmService, useValue: { confirm } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
      ],
    });
    TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
    const c = TestBed.createComponent(AdminSiteDetailComponent).componentInstance;
    const SNAP = { id: 'snap-9', snapshot_name: 'launch-v3' } as never;

    const p1 = c.onRollbackClick(SNAP);
    c.onRollbackClick(SNAP); // second click while the first confirm is still open
    expect(confirm).withContext('only one confirm dialog despite two rapid clicks').toHaveBeenCalledTimes(1);
    resolveConfirm(true);
    await p1;
    expect(post).toHaveBeenCalledTimes(1);
  });
});

/**
 * Deep-linkable tabs — a `?tab=sql` URL opens that tab (bookmarkable/shareable),
 * and clicking a tab reflects it in the URL (replaceUrl, merge — SPA, no reload).
 */
describe('AdminSiteDetailComponent (deep-linkable tabs)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function makeWithTab(tabParam: string | null): { c: AdminSiteDetailComponent; nav: jasmine.Spy } {
    const api = {
      get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' } })),
      post: jasmine.createSpy('post').and.returnValue(of({ ok: true })),
    };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: (k: string) => (k === 'tab' ? tabParam : null) }) } },
      ],
    });
    TestBed.overrideComponent(AdminSiteDetailComponent, { set: { template: '<div></div>', imports: [] } });
    const nav = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const c = TestBed.createComponent(AdminSiteDetailComponent).componentInstance;
    return { c, nav };
  }

  it('opens the tab named in ?tab= (deep-link / bookmark)', () => {
    expect(makeWithTab('sql').c.tab()).toBe('sql');
  });

  it('ignores an unknown ?tab= value (falls back to the default logs tab)', () => {
    expect(makeWithTab('bogus').c.tab()).toBe('logs');
  });

  it('setTab reflects the tab in the URL (bookmarkable: replaceUrl + merge)', () => {
    const { c, nav } = makeWithTab(null);
    c.setTab('integrations');
    expect(c.tab()).toBe('integrations');
    expect(nav).toHaveBeenCalled();
    const opts = nav.calls.mostRecent().args[1] as { queryParams: unknown; replaceUrl: boolean; queryParamsHandling: string };
    expect(opts.queryParams).toEqual({ tab: 'integrations' });
    expect(opts.replaceUrl).toBeTrue();
    expect(opts.queryParamsHandling).toBe('merge');
  });
});

/**
 * Timestamp rendering (log `ts` + snapshot `created_at`) used to leak a raw
 * ISO/D1 string into the UI. formatTs renders a readable local date/time but is
 * DEFENSIVE: an unparseable value (already-formatted / relative / empty) is
 * returned unchanged, so it never produces "Invalid Date".
 */
describe('AdminSiteDetailComponent (formatTs defensive timestamp formatting)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function comp(): AdminSiteDetailComponent {
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { get: () => of({ site: null }), post: () => of({}) } },
        { provide: AdminStateService, useValue: superAdminState(true) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: () => null }) } },
      ],
    });
    return TestBed.createComponent(AdminSiteDetailComponent).componentInstance;
  }

  it('formats a parseable ISO timestamp to a readable local string (not the raw ISO)', () => {
    const c = comp();
    const out = c.formatTs('2026-06-08T12:34:56.000Z');
    expect(out).withContext('year present in the formatted output').toContain('26');
    expect(out).withContext('not the raw ISO string').not.toBe('2026-06-08T12:34:56.000Z');
  });

  it('returns an unparseable / already-formatted value UNCHANGED (never "Invalid Date")', () => {
    const c = comp();
    expect(c.formatTs('just now')).toBe('just now');
    expect(c.formatTs('12:34:56')).toBe('12:34:56');
    expect(c.formatTs('')).toBe('');
    expect(c.formatTs(null)).toBe('');
    expect(c.formatTs(undefined)).toBe('');
  });
});

/**
 * SQL console is a PLATFORM SUPER-ADMIN power tool — `/sites/:id/sql/exec` 403s
 * every non-super-admin (AL-792). A regular site owner must never see the SQL tab
 * (a doomed control that will only ever fail) — it's hidden unless `is_super_admin`
 * (hydrated from `/api/auth/me` into AdminStateService.isSuperAdmin) is true, and a
 * non-super-admin can never land on it (fallback to the first visible tab).
 */
describe('AdminSiteDetailComponent (SQL tab gated on super-admin)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(isSuperAdmin: boolean, tabParam: string | null = null): import('@angular/core/testing').ComponentFixture<AdminSiteDetailComponent> {
    const api = { get: jasmine.createSpy('get').and.returnValue(of({ data: { id: 'site-1', slug: 's', business_name: 'S' }, columns: [], rows: [], logs: [], snapshots: [] })), post: jasmine.createSpy('post').and.returnValue(of({ ok: true })) };
    TestBed.configureTestingModule({
      imports: [AdminSiteDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AdminStateService, useValue: superAdminState(isSuperAdmin) },
        { provide: ActivatedRoute, useValue: { paramMap: of({ get: () => 'site-1' }), queryParamMap: of({ get: (k: string) => (k === 'tab' ? tabParam : null) }) } },
      ],
    });
    const f = TestBed.createComponent(AdminSiteDetailComponent);
    f.detectChanges();
    return f;
  }

  it('HIDES the SQL tab button + panel for a non-super-admin (site owner)', () => {
    const f = render(false);
    const host = f.nativeElement as HTMLElement;
    expect(f.componentInstance.canUseSqlConsole()).withContext('computed reflects a falsy is_super_admin').toBeFalse();
    expect(host.querySelector('[data-testid="sd-tab-sql"]')).withContext('no SQL tab button for a site owner').toBeNull();
    // Even forcing the active tab to sql must not render the panel (doomed control never shown).
    f.componentInstance.tab.set('sql');
    f.detectChanges();
    expect(host.querySelector('[data-testid="site-sql-panel"]')).withContext('SQL panel never renders for a non-super-admin').toBeNull();
  });

  it('SHOWS the SQL tab for a platform super-admin', () => {
    const f = render(true);
    const host = f.nativeElement as HTMLElement;
    expect(f.componentInstance.canUseSqlConsole()).toBeTrue();
    expect(host.querySelector('[data-testid="sd-tab-sql"]')).withContext('super-admin sees the SQL tab').not.toBeNull();
    f.componentInstance.setTab('sql');
    f.detectChanges();
    expect(host.querySelector('[data-testid="site-sql-panel"]')).withContext('super-admin can open the SQL panel').not.toBeNull();
  });

  it('a non-super-admin deep-linking ?tab=sql falls back to the first visible tab (logs), never a blank SQL panel', () => {
    const f = render(false, 'sql');
    expect(f.componentInstance.tab()).withContext('SQL is not a valid landing tab for a site owner').toBe('logs');
    expect((f.nativeElement as HTMLElement).querySelector('[data-testid="site-sql-panel"]')).toBeNull();
  });

  it('runSql is a no-op for a non-super-admin (server 403s them — never fire the POST)', () => {
    const { c, post } = make(jasmine.createSpy('post'), /* isSuperAdmin */ false);
    c.sqlQuery.set('SELECT * FROM sites');
    c.runSql();
    expect(post).withContext('a site owner must not reach /sql/exec').not.toHaveBeenCalled();
  });
});
