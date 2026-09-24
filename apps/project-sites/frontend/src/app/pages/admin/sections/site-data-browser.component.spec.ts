import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { ConfirmService } from '../../../services/confirm.service';
import { ToastService } from '../../../services/toast.service';
import { SiteDataBrowserComponent } from './site-data-browser.component';

/**
 * SiteDataBrowserComponent — the owner-facing "Data" tab body. Every surface is
 * backed by a real, tenant-scoped endpoint (`/data-overview` + `/data-overview/:table`),
 * so these specs assert the browse/sort/paginate contract against a mocked ApiService
 * that echoes the requested window (as the real, offset-honoring worker does).
 */

const COLS = ['event_type', 'path', 'referrer', 'created_at'];
const ROWS = [
  { event_type: 'pageview', path: '/', referrer: null, created_at: '2026-09-23T12:00:00Z' },
  { event_type: 'pageview', path: '/pricing', referrer: 'https://google.com', created_at: '2026-09-23T12:01:00Z' },
];

const OVERVIEW = {
  data: {
    tables: [
      { key: 'visitor_events', label: 'Visitor Events', description: 'Analytics pageviews and events', columns: COLS, row_count: 3, browsable: true, deletable: false, last_activity: '2026-09-20 12:00:00' },
      { key: 'form_submissions', label: 'Form Submissions', description: 'Contact and lead form entries', columns: ['form_name', 'status', 'email', 'created_at'], row_count: 2, browsable: true, deletable: true, editableColumns: { status: { type: 'enum', options: ['received', 'forwarded', 'partial', 'failed'] } }, last_activity: null },
    ],
  },
};

/** A browse spy that echoes the requested limit/offset back (as the worker does). */
function browsePage(total: number): jasmine.Spy {
  return jasmine
    .createSpy('browseDataTable')
    .and.callFake((_id: string, _table: string, opts: { limit?: number; offset?: number } = {}) =>
      of({ data: { table: 'visitor_events', columns: COLS, rows: ROWS }, total, limit: opts.limit ?? 25, offset: opts.offset ?? 0 }),
    );
}

/** A browse spy that serves `total` synthetic rows across real pages (honors offset). */
function pagedBrowse(total: number, rowsPerPage = 100): jasmine.Spy {
  return jasmine
    .createSpy('browseDataTable')
    .and.callFake((_id: string, _table: string, opts: { limit?: number; offset?: number } = {}) => {
      const offset = opts.offset ?? 0;
      const n = Math.max(0, Math.min(rowsPerPage, total - offset));
      const rows = Array.from({ length: n }, (_, i) => ({
        event_type: 'pageview',
        path: '/p' + (offset + i),
        referrer: null,
        created_at: 'x',
      }));
      return of({ data: { table: 'visitor_events', columns: COLS, rows }, total, limit: rowsPerPage, offset });
    });
}

function setup(overrides?: {
  getDataOverview?: jasmine.Spy;
  browseDataTable?: jasmine.Spy;
  deleteOverviewRow?: jasmine.Spy;
  bulkDeleteOverviewRows?: jasmine.Spy;
  updateOverviewRow?: jasmine.Spy;
  getDataActivity?: jasmine.Spy;
  confirmResult?: boolean;
}) {
  const getDataOverview = overrides?.getDataOverview ?? jasmine.createSpy('getDataOverview').and.returnValue(of(OVERVIEW));
  const browseDataTable = overrides?.browseDataTable ?? browsePage(3);
  const deleteOverviewRow =
    overrides?.deleteOverviewRow ??
    jasmine.createSpy('deleteOverviewRow').and.returnValue(of({ data: { id: 'r', deleted: true } }));
  const bulkDeleteOverviewRows =
    overrides?.bulkDeleteOverviewRows ??
    jasmine
      .createSpy('bulkDeleteOverviewRows')
      .and.returnValue(of({ data: { requested: 2, deleted: 2, skipped: 0 } }));
  const updateOverviewRow =
    overrides?.updateOverviewRow ??
    jasmine.createSpy('updateOverviewRow').and.returnValue(of({ data: { id: 'r', column: 'status', value: 'forwarded', updated: true } }));
  const getDataActivity =
    overrides?.getDataActivity ??
    jasmine.createSpy('getDataActivity').and.returnValue(of({ data: { events: [] } }));
  const api = { getDataOverview, browseDataTable, deleteOverviewRow, bulkDeleteOverviewRows, updateOverviewRow, getDataActivity };
  // Mock ConfirmService + ToastService so the real CDK-Dialog-backed ConfirmService
  // never constructs in the unit harness (and so delete specs can drive the outcome).
  const confirmSpy = jasmine.createSpy('confirm').and.resolveTo(overrides?.confirmResult ?? true);
  const confirm = { confirm: confirmSpy };
  const toast = { success: jasmine.createSpy('success'), error: jasmine.createSpy('error') };
  TestBed.configureTestingModule({
    imports: [SiteDataBrowserComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: ConfirmService, useValue: confirm },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fixture = TestBed.createComponent(SiteDataBrowserComponent);
  fixture.componentRef.setInput('siteId', 'site-1');
  return { fixture, c: fixture.componentInstance, getDataOverview, browseDataTable, deleteOverviewRow, bulkDeleteOverviewRows, updateOverviewRow, getDataActivity, confirmSpy, toast };
}

describe('SiteDataBrowserComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('loads the table overview and launches on the first NON-empty table', () => {
    const { fixture, c, browseDataTable } = setup();
    fixture.detectChanges(); // ngOnInit → load overview → auto-select
    expect(c.tables().length).toBe(2);
    // visitor_events (3 rows) is chosen over form_submissions (0 rows).
    expect(c.selected()?.key).toBe('visitor_events');
    expect(browseDataTable).toHaveBeenCalledWith('site-1', 'visitor_events', jasmine.objectContaining({ offset: 0 }));
    expect(c.rows().length).toBe(2);
    expect(c.total()).toBe(3);
  });

  it('renders one chip per table (with its row count) and one grid row per row', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const chip = fixture.debugElement.query(By.css('[data-testid="db-table-visitor_events"]'));
    expect(chip).withContext('table chip present').toBeTruthy();
    expect(chip.nativeElement.textContent).toContain('3');
    expect(fixture.debugElement.queryAll(By.css('[data-testid="db-row"]')).length).toBe(2);
  });

  it('rangeLabel reports the applied window honestly', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    expect(c.rangeLabel()).toBe('1–2 of 3');
  });

  it('sortBy sets the column ascending, then toggles direction, re-requesting with orderBy', () => {
    const { fixture, c, browseDataTable } = setup();
    fixture.detectChanges();
    c.sortBy('path');
    expect(c.orderBy()).toBe('path');
    expect(c.dir()).toBe('asc');
    expect(browseDataTable.calls.mostRecent().args[2]).toEqual(jasmine.objectContaining({ orderBy: 'path', dir: 'asc', offset: 0 }));
    c.sortBy('path');
    expect(c.dir()).toBe('desc');
    // aria-sort reflects the active column/direction (WCAG sortable semantics).
    expect(c.ariaSort('path')).toBe('descending');
    expect(c.ariaSort('created_at')).toBe('none');
  });

  it('sortBy ignores a column outside the returned allowlist (never sends a bad orderBy)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.sortBy('DROP TABLE sites');
    expect(c.orderBy()).toBeNull();
  });

  it('setSearch trims, resets to page 1, re-requests with the search, and no-ops when unchanged', () => {
    const { fixture, c, browseDataTable } = setup();
    fixture.detectChanges();
    c.offset.set(50);
    c.setSearch('  gmail  ');
    expect(c.search()).withContext('trimmed').toBe('gmail');
    expect(c.offset()).withContext('new search resets to the first page').toBe(0);
    expect(browseDataTable.calls.mostRecent().args[2])
      .toEqual(jasmine.objectContaining({ search: 'gmail', offset: 0 }));
    const before = browseDataTable.calls.count();
    c.setSearch('gmail'); // same trimmed value → no redundant refetch
    expect(browseDataTable.calls.count()).withContext('unchanged search does not refetch').toBe(before);
  });

  it('selectTable clears an active search (a new table starts unfiltered)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.setSearch('x');
    expect(c.search()).toBe('x');
    c.selectTable(c.tables()[1]);
    expect(c.search()).toBe('');
  });

  it('nextPage advances the offset by the page size and re-requests that window', () => {
    const { fixture, c, browseDataTable } = setup({ browseDataTable: browsePage(60) });
    fixture.detectChanges();
    expect(c.canNext()).toBeTrue(); // 0 + 25 < 60
    expect(c.canPrev()).toBeFalse();
    c.nextPage();
    expect(c.offset()).toBe(25);
    expect(browseDataTable.calls.mostRecent().args[2]).toEqual(jasmine.objectContaining({ offset: 25, limit: 25 }));
    expect(c.canPrev()).toBeTrue();
  });

  it('setLimit changes page size and resets to the first page', () => {
    const { fixture, c, browseDataTable } = setup({ browseDataTable: browsePage(60) });
    fixture.detectChanges();
    c.nextPage(); // offset → 25
    c.setLimit(50);
    expect(c.limit()).toBe(50);
    expect(c.offset()).toBe(0);
    expect(browseDataTable.calls.mostRecent().args[2]).toEqual(jasmine.objectContaining({ limit: 50, offset: 0 }));
  });

  it('surfaces a retryable error (no fake empty) when the overview response is shapeless', () => {
    const { c } = setup({ getDataOverview: jasmine.createSpy('getDataOverview').and.returnValue(of({})) });
    c.loadTables('site-1'); // direct call — assert the signal without rendering the error card
    expect(c.tables()).toEqual([]);
    expect(c.tablesError()).toContain('unexpected');
  });

  it('surfaces a retryable error when the overview load hard-fails', () => {
    const { c } = setup({ getDataOverview: jasmine.createSpy('getDataOverview').and.returnValue(throwError(() => ({ status: 500 }))) });
    c.loadTables('site-1');
    expect(c.tablesError()).toBeTruthy();
    expect(c.tables()).toEqual([]);
  });

  it('surfaces a rows error (never a fake success) when a page load fails', () => {
    const browseDataTable = jasmine.createSpy('browseDataTable').and.returnValue(throwError(() => ({ status: 500 })));
    const { c } = setup({ browseDataTable });
    c.loadTables('site-1'); // synchronous: auto-selects → loadPage → error, no render
    expect(c.rowsError()).toBeTruthy();
    expect(c.rows()).toEqual([]);
  });

  it('shows an honest empty-table message (not a page-past-end message) when total is 0', () => {
    const overview = { data: { tables: [{ key: 'form_submissions', label: 'Form Submissions', description: 'x', columns: ['form_name', 'status', 'email', 'created_at'], row_count: 0, browsable: true, deletable: true }] } };
    const getDataOverview = jasmine.createSpy('getDataOverview').and.returnValue(of(overview));
    const browseDataTable = jasmine.createSpy('browseDataTable').and.returnValue(of({ data: { table: 'form_submissions', columns: ['form_name', 'status', 'email', 'created_at'], rows: [] }, total: 0, limit: 25, offset: 0 }));
    const { c } = setup({ getDataOverview, browseDataTable });
    c.loadTables('site-1');
    expect(c.rows()).toEqual([]);
    expect(c.total()).toBe(0);
    expect(c.emptyText()).toContain('empty');
  });

  it('formatCell/rowJson render objects as JSON and scalars as strings', () => {
    const { c } = setup();
    expect(c.formatCell(5)).toBe('5');
    expect(c.formatCell('/pricing')).toBe('/pricing');
    expect(c.formatCell({ a: 1 })).toBe('{"a":1}');
    expect(c.rowJson({ path: '/', hits: 2 })).toContain('"hits": 2');
  });

  describe('export (whole table → CSV / JSON, bounded, read-only)', () => {
    it('exportCsv downloads the fetched rows as a text/csv blob with the table columns', async () => {
      const { fixture, c } = setup();
      fixture.detectChanges();
      const createSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:mock');
      spyOn(URL, 'revokeObjectURL');
      await c.exportCsv();
      expect(createSpy).toHaveBeenCalled();
      const blob = createSpy.calls.mostRecent().args[0] as Blob;
      expect(blob.type).toContain('text/csv');
      const text = await blob.text();
      expect(text).toContain('event_type,path,referrer,created_at'); // header
      expect(text).toContain('pageview'); // a real row, not mock
    });

    it('exportJson downloads the fetched rows as an application/json blob', async () => {
      const { fixture, c } = setup();
      fixture.detectChanges();
      const createSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:mock');
      spyOn(URL, 'revokeObjectURL');
      await c.exportJson();
      const blob = createSpy.calls.mostRecent().args[0] as Blob;
      expect(blob.type).toContain('application/json');
      expect(await blob.text()).toContain('"event_type": "pageview"');
    });

    it('fetches the WHOLE table across pages, not just the visible page', async () => {
      const paged = pagedBrowse(250);
      const { fixture, c } = setup({ browseDataTable: paged });
      fixture.detectChanges();
      paged.calls.reset(); // ignore the initial page load
      const createSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:mock');
      spyOn(URL, 'revokeObjectURL');
      await c.exportCsv();
      // 250 rows / 100 per page → 3 export fetches at offsets 0, 100, 200.
      expect(paged.calls.count()).toBe(3);
      expect(paged.calls.allArgs().map((a) => (a[2] as { offset?: number }).offset)).toEqual([0, 100, 200]);
      const text = await (createSpy.calls.mostRecent().args[0] as Blob).text();
      expect(text.trimEnd().split('\n').length).toBe(251); // 1 header + 250 rows
      expect(c.exportNote()).toBeNull(); // 250 < cap → not capped
    });

    it('caps the export at 5,000 rows and sets an honest capped note', async () => {
      const { fixture, c } = setup({ browseDataTable: pagedBrowse(20000) });
      fixture.detectChanges();
      const createSpy = spyOn(URL, 'createObjectURL').and.returnValue('blob:mock');
      spyOn(URL, 'revokeObjectURL');
      await c.exportCsv();
      expect(createSpy).toHaveBeenCalled();
      expect(c.exportNote()).toContain('5,000');
      expect(c.exportNote()).toContain('20,000');
      const text = await (createSpy.calls.mostRecent().args[0] as Blob).text();
      expect(text.trimEnd().split('\n').length).toBe(5001); // 1 header + 5,000 rows
    });

    it('exports the FILTERED view — threads the active search + column filter into the export fetches', async () => {
      const { fixture, c, browseDataTable } = setup();
      fixture.detectChanges();
      c.setSearch('gmail');
      c.applyColumnFilter('event_type', 'pageview');
      browseDataTable.calls.reset(); // ignore the grid reloads; watch only the export
      spyOn(URL, 'createObjectURL').and.returnValue('blob:mock');
      spyOn(URL, 'revokeObjectURL');
      await c.exportCsv();
      const args = browseDataTable.calls.mostRecent().args[2] as {
        search?: string;
        filterCol?: string;
        filterVal?: string;
      };
      expect(args.search).withContext('export carries the active search').toBe('gmail');
      expect(args.filterCol).toBe('event_type');
      expect(args.filterVal).toBe('pageview');
    });

    it('filterActive() is true with an active search OR column filter (drives the -filtered file name)', () => {
      const { fixture, c } = setup();
      fixture.detectChanges();
      expect(c.filterActive()).withContext('no filter initially').toBe(false);
      c.setSearch('x');
      expect(c.filterActive()).withContext('text search active').toBe(true);
      c.setSearch('');
      c.applyColumnFilter('event_type', 'pageview');
      expect(c.filterActive()).withContext('column filter active').toBe(true);
    });

    it('both exports are a no-op when the table is empty (never a blank file)', async () => {
      const { fixture, c } = setup();
      fixture.detectChanges();
      c.total.set(0);
      const createSpy = spyOn(URL, 'createObjectURL');
      await c.exportCsv();
      await c.exportJson();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('renders a read-only pill that explains rows cannot be edited from this grid', () => {
      const { fixture } = setup();
      fixture.detectChanges();
      const pill = fixture.debugElement.query(By.css('[data-testid="db-readonly-pill"]'));
      expect(pill).withContext('read-only pill present').toBeTruthy();
      expect(pill.nativeElement.textContent).toContain('Read-only');
      expect(pill.nativeElement.getAttribute('title')).toContain('site editor');
    });
  });
});

describe('SiteDataBrowserComponent — column show/hide', () => {
  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
    TestBed.resetTestingModule();
  });

  it('shows every column by default', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    expect(c.visibleColumns()).toEqual(COLS);
    expect(c.hiddenColumns().size).toBe(0);
  });

  it('hides a column from the grid but keeps columns() intact (detail + export unaffected)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.toggleColumn('referrer');
    expect(c.visibleColumns()).toEqual(['event_type', 'path', 'created_at']);
    expect(c.hiddenColumns().has('referrer')).toBe(true);
    expect(c.columns()).withContext('full column set stays intact for detail + export').toEqual(COLS);
  });

  it('renders only the visible columns in the grid header', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.toggleColumn('referrer');
    fixture.detectChanges();
    const ids = fixture.debugElement
      .queryAll(By.css('[data-testid^="db-sort-"]'))
      .map((b) => b.nativeElement.getAttribute('data-testid'));
    expect(ids).not.toContain('db-sort-referrer');
    expect(ids).toContain('db-sort-path');
  });

  it('showAllColumns restores every column', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.toggleColumn('referrer');
    c.toggleColumn('path');
    expect(c.visibleColumns().length).toBe(2);
    c.showAllColumns();
    expect(c.visibleColumns()).toEqual(COLS);
    expect(c.hiddenColumns().size).toBe(0);
  });

  it('never hides the LAST visible column (no dead-end empty grid)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.toggleColumn('event_type');
    c.toggleColumn('path');
    c.toggleColumn('referrer');
    expect(c.visibleColumns()).toEqual(['created_at']);
    c.toggleColumn('created_at'); // refused — would empty the grid
    expect(c.visibleColumns()).withContext('the last column cannot be hidden').toEqual(['created_at']);
  });

  it('persists the hidden set per (site, table) and restores it on the next mount', () => {
    const first = setup();
    first.fixture.detectChanges();
    first.c.toggleColumn('referrer');
    expect(localStorage.getItem('ps_datacols_hidden_site-1_visitor_events')).toContain('referrer');
    TestBed.resetTestingModule();
    const second = setup();
    second.fixture.detectChanges();
    expect(second.c.hiddenColumns().has('referrer')).toBe(true);
    expect(second.c.visibleColumns()).not.toContain('referrer');
  });

  it('isolates the hidden set per table (switching tables loads that table’s own set)', () => {
    localStorage.setItem('ps_datacols_hidden_site-1_form_submissions', JSON.stringify(['email']));
    const { fixture, c } = setup();
    fixture.detectChanges(); // launches on visitor_events (non-empty) → nothing hidden there
    expect(c.hiddenColumns().size).toBe(0);
    c.selectTable({
      key: 'form_submissions',
      label: 'Form Submissions',
      description: '',
      columns: ['form_name', 'status', 'email', 'created_at'],
      row_count: 0,
      browsable: true,
      deletable: true,
    });
    expect(c.hiddenColumns().has('email')).withContext('per-table preference restored on switch').toBe(true);
  });
});

/**
 * Copy affordances (read-only, in-spec "row detail, copy"): every non-null grid cell
 * is a click-to-copy button, the row detail has a "Copy JSON" action, and a polite
 * aria-live flash confirms the copy. writeClipboard is isolated so specs can spy it
 * without a secure-context clipboard.
 */
describe('SiteDataBrowserComponent — copy affordances', () => {
  afterEach(() => TestBed.resetTestingModule());

  type Clip = { writeClipboard(t: string): Promise<void> };

  it('copyValue copies a raw string value + flashes a copied indicator', async () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    const spy = spyOn(c as unknown as Clip, 'writeClipboard').and.resolveTo();
    await c.copyValue('owner@example.com');
    expect(spy).toHaveBeenCalledWith('owner@example.com');
    expect(c.copied()).toContain('Copied');
  });

  it('copyValue serializes an object value as compact JSON', async () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    const spy = spyOn(c as unknown as Clip, 'writeClipboard').and.resolveTo();
    await c.copyValue({ a: 1 });
    expect(spy).toHaveBeenCalledWith('{"a":1}');
  });

  it('copyRow copies the whole row as pretty JSON', async () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    const spy = spyOn(c as unknown as Clip, 'writeClipboard').and.resolveTo();
    await c.copyRow({ event_type: 'pageview', path: '/' });
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ event_type: 'pageview', path: '/' }, null, 2));
    expect(c.copied()).toBe('Copied row JSON');
  });

  it('renders each non-null cell as a copy button and copies its value on click', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    const spy = spyOn(c as unknown as Clip, 'writeClipboard').and.resolveTo();
    const cellBtn = fixture.debugElement.query(By.css('[data-testid="db-copy-event_type"]'));
    expect(cellBtn).withContext('cells render as click-to-copy buttons').toBeTruthy();
    cellBtn.nativeElement.click();
    expect(spy).toHaveBeenCalledWith('pageview'); // ROWS[0].event_type
  });

  it('exposes a polite aria-live copied flash after a copy', async () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    spyOn(c as unknown as Clip, 'writeClipboard').and.resolveTo();
    await c.copyValue('x');
    fixture.detectChanges();
    const flash = fixture.debugElement.query(By.css('[data-testid="db-copied"]'));
    expect(flash).withContext('flash appears').toBeTruthy();
    expect(flash.nativeElement.getAttribute('aria-live')).toBe('polite');
  });
});

/**
 * Per-column exact-match filter (in-spec "filters"): a column dropdown + value drive
 * a server-side parameterized `= ?` (column allowlist-validated server-side). Resets
 * to page 1, clears on table switch, and the value input is gated on a chosen column.
 */
describe('SiteDataBrowserComponent — per-column filter', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('applyColumnFilter sends filterCol/filterVal to the browse call + resets to page 1', () => {
    const { fixture, c, browseDataTable } = setup();
    fixture.detectChanges();
    c.offset.set(50);
    c.applyColumnFilter('event_type', ' pageview ');
    expect(c.filterCol()).toBe('event_type');
    expect(c.filterVal()).withContext('value trimmed').toBe('pageview');
    expect(c.offset()).withContext('filter resets to first page').toBe(0);
    expect(browseDataTable.calls.mostRecent().args[2]).toEqual(
      jasmine.objectContaining({ filterCol: 'event_type', filterVal: 'pageview', offset: 0 }),
    );
  });

  it('clearColumnFilter removes the filter + reloads unfiltered', () => {
    const { fixture, c, browseDataTable } = setup();
    fixture.detectChanges();
    c.applyColumnFilter('event_type', 'pageview');
    c.clearColumnFilter();
    expect(c.filterCol()).toBe('');
    expect(c.filterVal()).toBe('');
    expect(browseDataTable.calls.mostRecent().args[2].filterCol).toBeUndefined();
    expect(browseDataTable.calls.mostRecent().args[2].filterVal).toBeUndefined();
  });

  it('selectTable clears an active column filter (a new table starts unfiltered)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.applyColumnFilter('event_type', 'pageview');
    c.selectTable(c.tables()[1]);
    expect(c.filterCol()).toBe('');
    expect(c.filterVal()).toBe('');
  });

  it('renders the filter controls; the value input is disabled until a column is chosen', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="db-colfilter-col"]')).withContext('column select renders').toBeTruthy();
    const val = host.querySelector('[data-testid="db-colfilter-val"]') as HTMLInputElement;
    expect(val).toBeTruthy();
    expect(val.disabled).withContext('value disabled with no column chosen').toBe(true);
  });
});

/**
 * At-a-glance Overview summary — table count + total records + largest table,
 * derived from the already-fetched per-table row counts (no extra request).
 * Null (hidden) until tables load, so it never flashes a misleading "0 records".
 */
describe('SiteDataBrowserComponent — overview summary', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('derives tableCount + totalRows + the largest table from the loaded tables', () => {
    // OVERVIEW: visitor_events (3 rows) + form_submissions (2 rows) = 5 total.
    const { fixture, c } = setup();
    fixture.detectChanges();
    const s = c.dataSummary();
    expect(s).not.toBeNull();
    expect(s!.tableCount).toBe(2);
    expect(s!.totalRows).toBe(5);
    expect(s!.largest?.key).toBe('visitor_events');
  });

  it('is null before any tables load (no misleading "0 records" flash)', () => {
    const { c } = setup(); // not detected yet → tables() empty
    expect(c.dataSummary()).toBeNull();
  });

  it('renders the summary strip with the record total after load', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const strip = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="db-summary"]');
    expect(strip).withContext('summary strip renders').toBeTruthy();
    expect(strip!.textContent).toContain('2'); // tables
    expect(strip!.textContent).toContain('record');
    expect(strip!.textContent).toContain('Visitor Events'); // largest table label
  });
});

/**
 * Row delete — the owner may permanently delete their OWN rows from a DELETABLE
 * table (Form Submissions). Read-only tables show no delete affordance; the delete
 * only fires on a stable-`id` row after an explicit confirmation, and the server
 * re-checks the allowlist + tenant ownership + double-scopes by site.
 */
describe('SiteDataBrowserComponent — row delete', () => {
  afterEach(() => TestBed.resetTestingModule());

  const FS_COLS = ['form_name', 'status', 'email', 'created_at'];
  const FS_ROWS = [
    { id: 'row-abc', form_name: 'contact', status: 'received', email: 'a***@x.com', created_at: '2026-09-24T00:00:00Z' },
  ];
  /** A browse spy that serves form_submissions rows (each carrying a stable `id`). */
  function browseForm(): jasmine.Spy {
    return jasmine
      .createSpy('browseDataTable')
      .and.callFake((_id: string, table: string, opts: { limit?: number; offset?: number } = {}) =>
        of({ data: { table, columns: FS_COLS, rows: FS_ROWS }, total: FS_ROWS.length, limit: opts.limit ?? 25, offset: opts.offset ?? 0 }),
      );
  }
  const formTable = (c: SiteDataBrowserComponent) => c.tables().find((t) => t.key === 'form_submissions')!;
  const visitorTable = (c: SiteDataBrowserComponent) => c.tables().find((t) => t.key === 'visitor_events')!;

  it('renders a Delete button in row detail ONLY for a deletable table with a stable id', () => {
    const { fixture, c } = setup({ browseDataTable: browseForm() });
    fixture.detectChanges(); // loads overview + auto-selects visitor_events
    c.selectTable(formTable(c));
    fixture.detectChanges();
    c.toggleRow(0); // expand the row to reveal the detail bar
    fixture.detectChanges();
    const del = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="db-delete-row"]');
    expect(del).withContext('delete button shows for deletable form_submissions row').toBeTruthy();
  });

  it('shows NO delete button for a read-only table (visitor_events)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges(); // auto-selects visitor_events (deletable:false)
    c.selectTable(visitorTable(c));
    fixture.detectChanges();
    c.toggleRow(0);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="db-delete-row"]')).toBeNull();
  });

  it('deleteRow: confirms, calls the site-scoped delete, toasts, and refreshes both grid + counts', async () => {
    const deleteOverviewRow = jasmine
      .createSpy('deleteOverviewRow')
      .and.returnValue(of({ data: { id: 'row-abc', deleted: true } }));
    const { fixture, c, confirmSpy, toast, browseDataTable, getDataOverview } = setup({
      browseDataTable: browseForm(),
      deleteOverviewRow,
      confirmResult: true,
    });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    browseDataTable.calls.reset();
    getDataOverview.calls.reset();

    await c.deleteRow({ id: 'row-abc', form_name: 'contact' });

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteOverviewRow).toHaveBeenCalledWith('site-1', 'form_submissions', 'row-abc');
    expect(toast.success).toHaveBeenCalled();
    expect(browseDataTable).withContext('grid refetched').toHaveBeenCalled();
    expect(getDataOverview).withContext('table counts refetched').toHaveBeenCalled();
    expect(c.deletingId()).toBeNull();
  });

  it('deleteRow: does NOTHING when the user cancels the confirmation', async () => {
    const deleteOverviewRow = jasmine.createSpy('deleteOverviewRow');
    const { fixture, c } = setup({ browseDataTable: browseForm(), deleteOverviewRow, confirmResult: false });
    fixture.detectChanges(); // load the overview so the real form_submissions table (with label) resolves
    c.selected.set(formTable(c));
    await c.deleteRow({ id: 'row-abc' });
    expect(deleteOverviewRow).not.toHaveBeenCalled();
  });

  it('deleteRow: no-op on a read-only table or a row without a string id (never confirms/calls)', async () => {
    const deleteOverviewRow = jasmine.createSpy('deleteOverviewRow');
    const { fixture, c, confirmSpy } = setup({ deleteOverviewRow });
    fixture.detectChanges();
    c.selected.set(visitorTable(c)); // read-only table
    await c.deleteRow({ id: 'x' });
    c.selected.set(formTable(c)); // deletable, but row has no id
    await c.deleteRow({ form_name: 'no-id' });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteOverviewRow).not.toHaveBeenCalled();
  });

  it('deleteRow: surfaces an error toast (and clears the spinner) when the delete fails', async () => {
    const deleteOverviewRow = jasmine.createSpy('deleteOverviewRow').and.returnValue(throwError(() => ({ status: 500 })));
    const { fixture, c, toast } = setup({ browseDataTable: browseForm(), deleteOverviewRow, confirmResult: true });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    await c.deleteRow({ id: 'row-abc' });
    expect(toast.error).toHaveBeenCalled();
    expect(c.deletingId()).toBeNull();
  });
});

/**
 * Row edit — the owner may edit an allowlisted typed column of their OWN row
 * (currently `form_submissions.status`, an enum). Read-only tables show no editor;
 * Save is disabled until the value changes, confirms before writing, and the server
 * re-checks the allowlist + validates the value + double-scopes by site.
 */
describe('SiteDataBrowserComponent — row edit', () => {
  afterEach(() => TestBed.resetTestingModule());

  const FS_COLS = ['form_name', 'status', 'email', 'created_at'];
  const FS_ROWS = [
    { id: 'row-abc', form_name: 'contact', status: 'received', email: 'a***@x.com', created_at: '2026-09-24T00:00:00Z' },
  ];
  function browseForm(): jasmine.Spy {
    return jasmine
      .createSpy('browseDataTable')
      .and.callFake((_id: string, table: string, opts: { limit?: number; offset?: number } = {}) =>
        of({ data: { table, columns: FS_COLS, rows: FS_ROWS }, total: FS_ROWS.length, limit: opts.limit ?? 25, offset: opts.offset ?? 0 }),
      );
  }
  const formTable = (c: SiteDataBrowserComponent) => c.tables().find((t) => t.key === 'form_submissions')!;
  const visitorTable = (c: SiteDataBrowserComponent) => c.tables().find((t) => t.key === 'visitor_events')!;

  it('exposes the editable columns of the selected table ([] for a read-only table)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.selectTable(formTable(c));
    expect(c.editableColumnsList().map((e) => e.column)).toEqual(['status']);
    expect(c.editableColumnsList()[0].options).toEqual(['received', 'forwarded', 'partial', 'failed']);
    c.selectTable(visitorTable(c));
    expect(c.editableColumnsList()).toEqual([]);
  });

  it('renders an enum <select> + Save in row detail ONLY for an editable table', () => {
    const { fixture, c } = setup({ browseDataTable: browseForm() });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    fixture.detectChanges();
    c.toggleRow(0);
    fixture.detectChanges();
    const sel = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="db-edit-status"]');
    expect(sel).withContext('status select renders for form_submissions').toBeTruthy();
    expect(sel!.querySelectorAll('option').length).toBe(4);
  });

  it('draftValue/isEdited: Save enables only once the value actually changes', () => {
    const { fixture, c } = setup({ browseDataTable: browseForm() });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    const row = { id: 'row-abc', status: 'received' };
    expect(c.draftValue(row, 'status')).toBe('received');
    expect(c.isEdited(row, 'status')).toBe(false);
    c.setDraft('status', 'received'); // same value → not edited
    expect(c.isEdited(row, 'status')).toBe(false);
    c.setDraft('status', 'forwarded'); // changed → edited
    expect(c.draftValue(row, 'status')).toBe('forwarded');
    expect(c.isEdited(row, 'status')).toBe(true);
  });

  it('saveEdit: confirms, PATCHes the scoped column, toasts, and refreshes', async () => {
    const updateOverviewRow = jasmine
      .createSpy('updateOverviewRow')
      .and.returnValue(of({ data: { id: 'row-abc', column: 'status', value: 'forwarded', updated: true } }));
    const { fixture, c, confirmSpy, toast, browseDataTable } = setup({
      browseDataTable: browseForm(),
      updateOverviewRow,
      confirmResult: true,
    });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    c.setDraft('status', 'forwarded');
    browseDataTable.calls.reset();

    await c.saveEdit({ id: 'row-abc', status: 'received' }, 'status');

    expect(confirmSpy).toHaveBeenCalled();
    expect(updateOverviewRow).toHaveBeenCalledWith('site-1', 'form_submissions', 'row-abc', 'status', 'forwarded');
    expect(toast.success).toHaveBeenCalled();
    expect(browseDataTable).withContext('grid refetched').toHaveBeenCalled();
    expect(c.savingEdit()).toBeFalse();
    expect(c.editDraft()).toEqual({}); // draft cleared after save
  });

  it('saveEdit: cancelling the confirmation reverts the draft and calls nothing', async () => {
    const updateOverviewRow = jasmine.createSpy('updateOverviewRow');
    const { fixture, c } = setup({ browseDataTable: browseForm(), updateOverviewRow, confirmResult: false });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    c.setDraft('status', 'forwarded');
    await c.saveEdit({ id: 'row-abc', status: 'received' }, 'status');
    expect(updateOverviewRow).not.toHaveBeenCalled();
    expect(c.isEdited({ id: 'row-abc', status: 'received' }, 'status')).toBe(false); // reverted
  });

  it('saveEdit: no-op when unchanged, on a read-only table, or a row without an id', async () => {
    const updateOverviewRow = jasmine.createSpy('updateOverviewRow');
    const { fixture, c, confirmSpy } = setup({ browseDataTable: browseForm(), updateOverviewRow });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    await c.saveEdit({ id: 'row-abc', status: 'received' }, 'status'); // no draft → unchanged
    c.setDraft('status', 'forwarded');
    await c.saveEdit({ status: 'received' }, 'status'); // deletable/editable but no id
    c.selectTable(visitorTable(c));
    await c.saveEdit({ id: 'x', status: 'received' }, 'status'); // read-only table
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(updateOverviewRow).not.toHaveBeenCalled();
  });

  it('saveEdit: surfaces an error toast (and clears the spinner) when the update fails', async () => {
    const updateOverviewRow = jasmine.createSpy('updateOverviewRow').and.returnValue(throwError(() => ({ status: 500 })));
    const { fixture, c, toast } = setup({ browseDataTable: browseForm(), updateOverviewRow, confirmResult: true });
    fixture.detectChanges();
    c.selectTable(formTable(c));
    c.setDraft('status', 'forwarded');
    await c.saveEdit({ id: 'row-abc', status: 'received' }, 'status');
    expect(toast.error).toHaveBeenCalled();
    expect(c.savingEdit()).toBeFalse();
  });
});

/**
 * Overview "last activity" freshness — each table chip shows a compact relative age
 * (server MAX(ts)), or nothing when the table is empty. Server timestamps are UTC
 * `YYYY-MM-DD HH:MM:SS` (no zone); compactAge must parse them as UTC, not local.
 */
describe('SiteDataBrowserComponent — last-activity freshness', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a freshness chip for a table with last_activity, none for an empty one', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    // visitor_events has a timestamp → chip present; form_submissions is null → absent.
    expect(host.querySelector('[data-testid="db-table-fresh-visitor_events"]')).withContext('ts → chip').toBeTruthy();
    expect(host.querySelector('[data-testid="db-table-fresh-form_submissions"]')).withContext('null → no chip').toBeNull();
  });

  it('compactAge: buckets the age and parses UTC timestamps (not local)', () => {
    const c = setup().c;
    // Pin "now" to 2026-09-24 12:00:00 UTC for deterministic deltas.
    const now = Date.parse('2026-09-24T12:00:00Z');
    spyOn(c as unknown as { now(): number }, 'now').and.returnValue(now);
    expect(c.compactAge('2026-09-24 11:59:30')).toBe('just now'); // 30s
    expect(c.compactAge('2026-09-24 11:59:00')).toBe('1m'); // exactly 60s → 1m (boundary)
    expect(c.compactAge('2026-09-24 11:30:00')).toBe('30m');
    // UTC parse proof: '09:00:00' is 3h before 12:00 UTC → "3h". Parsed as LOCAL in a
    // non-UTC tz it would land in a different bucket; the code normalizes to UTC.
    expect(c.compactAge('2026-09-24 09:00:00')).toBe('3h');
    expect(c.compactAge('2026-09-22 12:00:00')).toBe('2d');
    expect(c.compactAge('2026-09-10 12:00:00')).toBe('2w');
  });

  it('compactAge: empty/null/unparseable → "" (template hides the chip, never a fake 0)', () => {
    const c = setup().c;
    expect(c.compactAge(null)).toBe('');
    expect(c.compactAge(undefined)).toBe('');
    expect(c.compactAge('not-a-date')).toBe('');
  });

  it('fullTimestamp: renders a real UTC instant (or "" for null/unparseable)', () => {
    const c = setup().c;
    expect(c.fullTimestamp('2026-09-24 12:00:00')).not.toBe('');
    expect(c.fullTimestamp(null)).toBe('');
    expect(c.fullTimestamp('nope')).toBe('');
  });
});

/**
 * Recent activity — the owner's OWN data mutations (deletes/edits), from the append-only
 * audit log via getDataActivity. Read-only, collapsed panel; refreshes after a delete/edit.
 */
describe('SiteDataBrowserComponent — recent activity', () => {
  afterEach(() => TestBed.resetTestingModule());

  const EVENTS = [
    { action: 'site_data.row_deleted', table: 'form_submissions', message: 'Deleted a row from form_submissions', actor: 'u1', at: '2026-09-24T12:00:00.000Z' },
    { action: 'site_data.row_updated', table: 'form_submissions', message: 'Updated status on a form_submissions row', actor: 'u1', at: '2026-09-23T09:00:00.000Z' },
  ];

  it('renders the activity panel with one item per mutation (newest first)', () => {
    const getDataActivity = jasmine.createSpy('getDataActivity').and.returnValue(of({ data: { events: EVENTS } }));
    const { fixture } = setup({ getDataActivity });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="db-activity"]')).withContext('panel renders with events').toBeTruthy();
    const items = host.querySelectorAll('[data-testid="db-activity-item"]');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('Deleted a row from form_submissions');
  });

  it('does NOT render the activity panel when there are no mutations', () => {
    const { fixture } = setup(); // default getDataActivity → empty events
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="db-activity"]')).toBeNull();
  });

  it('loads activity on init and refreshes it after a delete', async () => {
    const getDataActivity = jasmine.createSpy('getDataActivity').and.returnValue(of({ data: { events: EVENTS } }));
    const { fixture, c } = setup({ getDataActivity, confirmResult: true });
    fixture.detectChanges();
    expect(getDataActivity).toHaveBeenCalledWith('site-1'); // on init
    const before = getDataActivity.calls.count();
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    await c.deleteRow({ id: 'row-abc' });
    expect(getDataActivity.calls.count()).withContext('activity refetched after delete').toBeGreaterThan(before);
    expect(c.activity().length).toBe(2);
  });

  // ── Bulk selection + bulk delete (deletable tables only) ──────────────────────
  it('bulk-deletes the selected rows: confirm + parameterized bulk call + success toast', async () => {
    const bulkDeleteOverviewRows = jasmine
      .createSpy('bulkDeleteOverviewRows')
      .and.returnValue(of({ data: { requested: 2, deleted: 2, skipped: 0 } }));
    const { fixture, c, confirmSpy, toast } = setup({ bulkDeleteOverviewRows });
    fixture.detectChanges();
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    c.rows.set([{ id: 'r1', form_name: 'Contact' }, { id: 'r2', form_name: 'Contact' }]);
    c.toggleRowSelected(c.rows()[0]);
    c.toggleRowSelected(c.rows()[1]);
    expect(c.selectedCount()).toBe(2);

    await c.bulkDelete();
    expect(confirmSpy).toHaveBeenCalled();
    expect(bulkDeleteOverviewRows).toHaveBeenCalledWith('site-1', 'form_submissions', ['r1', 'r2']);
    expect(toast.success).toHaveBeenCalled();
  });

  it('renders selection checkboxes ONLY for a deletable table', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    c.rows.set([{ id: 'r1', form_name: 'Contact', status: 'received', email: 'a@x', created_at: 'x' }]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="db-select-all"]')).withContext('deletable → select-all').toBeTruthy();
    expect(el.querySelector('[data-testid="db-select-0"]')).withContext('deletable → row checkbox').toBeTruthy();

    c.selected.set(c.tables().find((t) => t.key === 'visitor_events')!);
    c.rows.set([{ event_type: 'pageview', path: '/p', referrer: null, created_at: 'x' }]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="db-select-all"]')).withContext('read-only → no select-all').toBeNull();
  });

  it('select-all selects every selectable row on the page (id-bearing rows only)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    c.rows.set([{ id: 'r1' }, { id: 'r2' }, { form_name: 'no-id' }]); // 3rd has no stable id
    c.toggleSelectAllPage();
    expect(c.selectedCount()).withContext('only id-bearing rows selected').toBe(2);
    expect(c.allPageSelected()).toBeTrue();
    c.toggleSelectAllPage();
    expect(c.selectedCount()).toBe(0);
  });

  it('cancelling the confirm does not call the bulk API', async () => {
    const bulkDeleteOverviewRows = jasmine
      .createSpy('bulkDeleteOverviewRows')
      .and.returnValue(of({ data: { requested: 1, deleted: 1, skipped: 0 } }));
    const { fixture, c } = setup({ bulkDeleteOverviewRows, confirmResult: false });
    fixture.detectChanges();
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    c.rows.set([{ id: 'r1' }]);
    c.toggleRowSelected(c.rows()[0]);
    await c.bulkDelete();
    expect(bulkDeleteOverviewRows).not.toHaveBeenCalled();
  });

  it('clears the selection on any re-fetch (a stale id can never be bulk-deleted)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    c.rows.set([{ id: 'r1' }, { id: 'r2' }]);
    c.toggleRowSelected(c.rows()[0]);
    expect(c.selectedCount()).toBe(1);
    c.loadPage(); // a sort/filter/page change re-fetches
    expect(c.selectedCount()).withContext('selection cleared on re-fetch').toBe(0);
  });

  it('reports honest partial results in the toast when some rows were already gone', async () => {
    const bulkDeleteOverviewRows = jasmine
      .createSpy('bulkDeleteOverviewRows')
      .and.returnValue(of({ data: { requested: 3, deleted: 1, skipped: 2 } }));
    const { fixture, c, toast } = setup({ bulkDeleteOverviewRows });
    fixture.detectChanges();
    c.selected.set(c.tables().find((t) => t.key === 'form_submissions')!);
    c.rows.set([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    c.rows().forEach((r) => c.toggleRowSelected(r));
    await c.bulkDelete();
    expect(toast.success).toHaveBeenCalledWith(jasmine.stringMatching(/Deleted 1 of 3.*already gone/));
  });
});
