import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { SiteSchemaBrowserComponent } from './site-schema-browser.component';

const SCHEMA = {
  data: {
    tables: [
      {
        name: 'sites',
        type: 'table',
        create_sql: 'CREATE TABLE sites (id TEXT PRIMARY KEY, slug TEXT)',
        columns: [
          { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
          { name: 'slug', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        ],
        indexes: [{ name: 'idx_sites_slug', unique: true, columns: ['slug'] }],
        foreign_keys: [{ from: 'org_id', table: 'orgs', to: 'id', on_update: 'CASCADE', on_delete: 'CASCADE' }],
      },
      {
        name: 'orgs',
        type: 'table',
        create_sql: 'CREATE TABLE orgs (id TEXT)',
        columns: [{ name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 }],
        indexes: [],
        foreign_keys: [],
      },
    ],
  },
};

function setup(getSiteSchema?: jasmine.Spy) {
  const spy = getSiteSchema ?? jasmine.createSpy('getSiteSchema').and.returnValue(of(SCHEMA));
  TestBed.configureTestingModule({
    imports: [SiteSchemaBrowserComponent],
    providers: [{ provide: ApiService, useValue: { getSiteSchema: spy } }],
  });
  const fixture = TestBed.createComponent(SiteSchemaBrowserComponent);
  fixture.componentRef.setInput('siteId', 'site-1');
  return { fixture, c: fixture.componentInstance, spy };
}

describe('SiteSchemaBrowserComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('loads the schema and auto-selects the first table', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    expect(c.tables().length).toBe(2);
    expect(c.selectedName()).toBe('sites');
  });

  it('renders a button per table and the selected table columns with a PK badge', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="sb-table-sites"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="sb-table-orgs"]'))).toBeTruthy();
    expect(fixture.debugElement.queryAll(By.css('[data-testid="sb-col"]')).length).toBe(2); // sites has 2 columns
    expect(fixture.debugElement.query(By.css('[data-testid="sb-pk"]'))).withContext('id column PK badge').toBeTruthy();
  });

  it('renders indexes, foreign keys, and the copyable CREATE SQL for the selected table', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect((fixture.debugElement.query(By.css('[data-testid="sb-index"]')).nativeElement as HTMLElement).textContent).toContain('idx_sites_slug');
    expect((fixture.debugElement.query(By.css('[data-testid="sb-fk"]')).nativeElement as HTMLElement).textContent).toContain('orgs.id');
    expect((fixture.debugElement.query(By.css('[data-testid="sb-ddl"]')).nativeElement as HTMLElement).textContent).toContain('CREATE TABLE sites');
  });

  it('filters the table list by the search box', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.search.set('org');
    expect(c.filteredTables().map((t) => t.name)).toEqual(['orgs']);
  });

  it('selecting a table switches the detail panel', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.select('orgs');
    expect(c.selected()?.name).toBe('orgs');
    expect(c.selected()?.columns.length).toBe(1);
  });

  it('surfaces a retryable error on a shapeless 200 (no fake empty schema)', () => {
    const { c } = setup(jasmine.createSpy('getSiteSchema').and.returnValue(of({})));
    c.load(); // direct call — assert the signal without rendering the error card
    expect(c.tables()).toEqual([]);
    expect(c.error()).toContain('unexpected');
  });

  it('surfaces an error when the schema load hard-fails', () => {
    const { c } = setup(jasmine.createSpy('getSiteSchema').and.returnValue(throwError(() => ({ status: 500 }))));
    c.load();
    expect(c.error()).toBeTruthy();
    expect(c.tables()).toEqual([]);
  });
});
