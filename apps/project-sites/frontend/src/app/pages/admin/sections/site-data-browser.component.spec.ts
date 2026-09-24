import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../../services/api.service';
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
      { key: 'visitor_events', label: 'Visitor Events', description: 'Analytics pageviews and events', columns: COLS, row_count: 3, browsable: true },
      { key: 'form_submissions', label: 'Form Submissions', description: 'Contact and lead form entries', columns: ['form_name', 'status', 'email', 'created_at'], row_count: 0, browsable: true },
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
}) {
  const getDataOverview = overrides?.getDataOverview ?? jasmine.createSpy('getDataOverview').and.returnValue(of(OVERVIEW));
  const browseDataTable = overrides?.browseDataTable ?? browsePage(3);
  const api = { getDataOverview, browseDataTable };
  TestBed.configureTestingModule({
    imports: [SiteDataBrowserComponent],
    providers: [{ provide: ApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(SiteDataBrowserComponent);
  fixture.componentRef.setInput('siteId', 'site-1');
  return { fixture, c: fixture.componentInstance, getDataOverview, browseDataTable };
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
    const overview = { data: { tables: [{ key: 'form_submissions', label: 'Form Submissions', description: 'x', columns: ['form_name', 'status', 'email', 'created_at'], row_count: 0, browsable: true }] } };
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
