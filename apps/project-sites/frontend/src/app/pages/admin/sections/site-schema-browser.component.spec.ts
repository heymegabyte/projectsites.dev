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
      {
        // Composite PK — pk is the 1-based KEY POSITION (org_id=1, user_id=2), order significant.
        name: 'memberships',
        type: 'table',
        create_sql:
          'CREATE TABLE memberships (org_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (org_id, user_id))',
        columns: [
          { name: 'org_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
          { name: 'user_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
          { name: 'role', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        ],
        indexes: [],
        foreign_keys: [],
      },
      {
        name: 'trg_sites_touch',
        type: 'trigger',
        create_sql:
          'CREATE TRIGGER trg_sites_touch AFTER UPDATE ON sites BEGIN UPDATE sites SET updated_at = 1; END',
        on_table: 'sites',
        columns: [],
        indexes: [],
        foreign_keys: [],
      },
    ],
  },
};

function setup(getSiteSchema?: jasmine.Spy, getSiteMigrations?: jasmine.Spy) {
  const spy = getSiteSchema ?? jasmine.createSpy('getSiteSchema').and.returnValue(of(SCHEMA));
  const migSpy =
    getSiteMigrations ??
    jasmine
      .createSpy('getSiteMigrations')
      .and.returnValue(of({ data: { available: true, count: 0, migrations: [] } }));
  TestBed.configureTestingModule({
    imports: [SiteSchemaBrowserComponent],
    providers: [
      { provide: ApiService, useValue: { getSiteSchema: spy, getSiteMigrations: migSpy } },
    ],
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
    expect(c.tables().length).toBe(4); // 3 tables + 1 trigger
    expect(c.selectedName()).toBe('sites');
  });

  it('renders the applied-migration ledger (newest first) from getSiteMigrations', () => {
    const mig = jasmine.createSpy('getSiteMigrations').and.returnValue(
      of({
        data: {
          available: true,
          count: 2,
          migrations: [
            { name: '0170_x.sql', applied_at: '2026-09-24 00:00:00' },
            { name: '0001_initial_schema.sql', applied_at: '2026-05-18 00:00:00' },
          ],
        },
      }),
    );
    const { fixture, c } = setup(undefined, mig);
    fixture.detectChanges();
    expect(c.migrationsAvailable()).toBeTrue();
    expect(c.migrations().length).toBe(2);
    const items = fixture.debugElement.queryAll(By.css('[data-testid="sb-mig-item"]'));
    expect(items.length).toBe(2);
    expect(items[0].nativeElement.textContent).toContain('0170_x.sql'); // newest first
  });

  it('shows an honest "ledger not available" state (never a fake empty) when d1_migrations is absent', () => {
    const mig = jasmine
      .createSpy('getSiteMigrations')
      .and.returnValue(of({ data: { available: false, count: 0, migrations: [] } }));
    const { fixture, c } = setup(undefined, mig);
    fixture.detectChanges();
    expect(c.migrationsAvailable()).toBeFalse();
    expect(fixture.debugElement.query(By.css('[data-testid="sb-mig-unavailable"]'))).toBeTruthy();
  });

  it('treats a migrations fetch failure (e.g. a 403) as unavailable, not an error', () => {
    const mig = jasmine
      .createSpy('getSiteMigrations')
      .and.returnValue(throwError(() => ({ status: 403 })));
    const { fixture, c } = setup(undefined, mig);
    fixture.detectChanges();
    expect(c.migrationsLoaded()).toBeTrue();
    expect(c.migrationsAvailable()).toBeFalse();
  });

  it('renders a button per table and the selected table columns with a PK badge', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="sb-table-sites"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="sb-table-orgs"]'))).toBeTruthy();
    expect(fixture.debugElement.queryAll(By.css('[data-testid="sb-col"]')).length).toBe(2); // sites has 2 columns
    expect(fixture.debugElement.query(By.css('[data-testid="sb-pk"]'))).withContext('id column PK badge').toBeTruthy();
  });

  it('surfaces composite-primary-key ORDER (per-column position + a composite summary)', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.select('memberships'); // composite PK: org_id (pos 1), user_id (pos 2)
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    // One PK badge per PK column, each carrying its 1-based key position.
    const badges = Array.from(host.querySelectorAll('[data-testid="sb-pk"]')).map((b) => b.textContent ?? '');
    expect(badges.length).toBe(2);
    expect(badges.some((t) => t.includes('1'))).withContext('PK position 1').toBeTrue();
    expect(badges.some((t) => t.includes('2'))).withContext('PK position 2').toBeTrue();
    // A composite summary spells out the key columns IN ORDER.
    const summary = host.querySelector('[data-testid="sb-pk-summary"]') as HTMLElement;
    expect(summary).withContext('composite-PK summary present').toBeTruthy();
    expect(summary.textContent).toContain('composite');
    expect(summary.textContent).toContain('org_id, user_id');
  });

  it('a single-column PK stays a plain "PK" (no position) with no composite summary', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    c.select('orgs'); // single PK (id)
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const badge = host.querySelector('[data-testid="sb-pk"]') as HTMLElement;
    expect(badge.textContent?.trim()).withContext('no trailing position digit').toBe('PK');
    expect(host.querySelector('[data-testid="sb-pk-summary"]')).withContext('no composite summary').toBeNull();
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

  it('renders a trigger with its "on <table>" label, a no-columns note, and the CREATE SQL', () => {
    const { fixture, c } = setup();
    fixture.detectChanges();
    // the trigger appears in the object list (type badge shows for non-tables)
    expect(fixture.debugElement.query(By.css('[data-testid="sb-table-trg_sites_touch"]'))).toBeTruthy();

    c.select('trg_sites_touch');
    fixture.detectChanges();

    const sub = fixture.debugElement.query(By.css('[data-testid="sb-detail-sub"]')).nativeElement as HTMLElement;
    expect(sub.textContent).toContain('trigger');
    expect(sub.textContent).withContext('shows the table it fires on').toContain('sites');
    // a trigger has no columns → the columns table is replaced by a note
    expect(fixture.debugElement.query(By.css('[data-testid="sb-columns"]'))).withContext('no columns table').toBeNull();
    expect(fixture.debugElement.query(By.css('[data-testid="sb-no-cols"]'))).withContext('no-columns note').toBeTruthy();
    // the CREATE TRIGGER SQL is still shown (copyable)
    expect((fixture.debugElement.query(By.css('[data-testid="sb-ddl"]')).nativeElement as HTMLElement).textContent).toContain('CREATE TRIGGER');
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
