import { CommonModule } from '@angular/common';
/**
 * Site Schema Browser — the "Schema" tab body on `/admin/sites/:id`.
 *
 * A read-only browser for the site's D1 schema, backed by the real (superadmin-only)
 * `GET /api/sites/:siteId/sql/schema` introspection endpoint — tables & views with
 * columns (type · nullability · default · primary key), indexes, foreign keys, plus
 * triggers (labelled with the table they fire on), and every object's CREATE SQL
 * (copyable). The companion to the SQL console: inspect the shape without writing a
 * query. Focused standalone component (signals + `input()` + native control flow);
 * no mock data — every panel comes from the live endpoint.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';
import { ErrorCardComponent } from '../../../components/states';
import { ApiService, type SchemaTable } from '../../../services/api.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MiniEmptyComponent, ErrorCardComponent],
  selector: 'app-site-schema-browser',
  standalone: true,
  styles: [`
    :host { display: block; }
    .sb-loading { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-size: 0.85rem; }
    .sb-toolbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.8rem; }
    .sb-search { flex: 1; min-width: 0; font: inherit; font-size: 0.82rem; padding: 0.4rem 0.6rem; border-radius: 8px; color: var(--ps-ink, #f4f4ff); background: rgba(0,0,0,0.25); border: 1px solid var(--ps-edge, rgba(255,255,255,0.12)); }
    .sb-search:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sb-count { font-size: 0.72rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-variant-numeric: tabular-nums; }
    .sb-refresh { font: inherit; font-size: 0.76rem; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 6px; color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent); border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent); }
    .sb-refresh:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); }
    .sb-refresh:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sb-layout { display: grid; grid-template-columns: minmax(160px, 240px) 1fr; gap: 1rem; align-items: start; }
    @media (max-width: 640px) { .sb-layout { grid-template-columns: 1fr; } }
    .sb-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.2rem; max-height: 60vh; overflow-y: auto; }
    .sb-table-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; cursor: pointer; font: inherit; font-size: 0.8rem; text-align: left; padding: 0.4rem 0.55rem; border-radius: 7px; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); background: transparent; border: 1px solid transparent; }
    .sb-table-btn:hover { background: rgba(255,255,255,0.04); }
    .sb-table-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sb-table-btn.is-active { color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); }
    .sb-table-name { font-family: 'JetBrains Mono', ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sb-table-meta { display: inline-flex; align-items: center; gap: 0.35rem; flex-shrink: 0; }
    .sb-type-badge { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.05rem 0.3rem; border-radius: 4px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent); }
    .sb-col-count { font-size: 0.68rem; font-variant-numeric: tabular-nums; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); }
    .sb-detail-head { margin-bottom: 0.6rem; }
    .sb-detail-name { margin: 0; font-size: 1rem; font-family: 'JetBrains Mono', ui-monospace, monospace; color: #fff; }
    .sb-detail-sub { font-size: 0.72rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .sb-scroll { overflow-x: auto; border-radius: 8px; border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); }
    .sb-scroll:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sb-cols { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .sb-cols th, .sb-cols td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); white-space: nowrap; }
    .sb-cols thead th { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.05em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .sb-col-name { font-family: 'JetBrains Mono', ui-monospace, monospace; color: #fff; }
    .sb-col-type, .sb-col-default { font-family: 'JetBrains Mono', ui-monospace, monospace; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
    .sb-pk { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em; padding: 0.05rem 0.35rem; border-radius: 4px; color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent); }
    .sb-section { margin-top: 0.9rem; }
    .sb-section-h { display: flex; align-items: center; gap: 0.5rem; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); margin-bottom: 0.4rem; }
    .sb-meta-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; font-size: 0.78rem; }
    .sb-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; color: #fff; }
    .sb-tag { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.05rem 0.3rem; border-radius: 4px; color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent); }
    .sb-dim { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); }
    .sb-copy { font: inherit; font-size: 0.66rem; cursor: pointer; padding: 0.15rem 0.5rem; border-radius: 5px; color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent); border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent); }
    .sb-copy:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); }
    .sb-copy:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .sb-ddl { margin: 0; padding: 0.6rem 0.75rem; border-radius: 8px; background: rgba(0,0,0,0.3); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.74rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 85%, transparent); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
    .sb-no-cols { margin: 0; font-size: 0.8rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
  `],
  template: `
    <div class="sb" data-testid="site-schema-browser">
      @if (loading()) {
        <p class="sb-loading" data-testid="sb-loading">Loading schema…</p>
      } @else if (error(); as err) {
        <app-error-card
          data-testid="sb-error"
          title="Couldn't load the schema"
          [message]="err"
          (retry)="load()"
        />
      } @else {
        <div class="sb-toolbar">
          <input
            class="sb-search"
            type="search"
            placeholder="Filter tables…"
            aria-label="Filter tables by name"
            data-testid="sb-search"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <span class="sb-count">{{ tables().length }} {{ tables().length === 1 ? 'object' : 'objects' }}</span>
          <button type="button" class="sb-refresh" (click)="load()" data-testid="sb-refresh" aria-label="Refresh schema">Refresh</button>
        </div>

        <div class="sb-layout">
          <ul class="sb-list" role="list" aria-label="Tables, views, and triggers" data-testid="sb-list">
            @for (t of filteredTables(); track t.name) {
              <li>
                <button
                  type="button"
                  class="sb-table-btn"
                  [class.is-active]="selectedName() === t.name"
                  [attr.aria-pressed]="selectedName() === t.name"
                  [attr.data-testid]="'sb-table-' + t.name"
                  (click)="select(t.name)"
                >
                  <span class="sb-table-name">{{ t.name }}</span>
                  <span class="sb-table-meta">
                    @if (t.type !== 'table') { <span class="sb-type-badge">{{ t.type }}</span> }
                    <span class="sb-col-count">{{ t.columns.length }}</span>
                  </span>
                </button>
              </li>
            } @empty {
              <li>
                <app-mini-empty [text]="tables().length ? 'No objects match your filter.' : 'No schema objects in this database.'">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
                </app-mini-empty>
              </li>
            }
          </ul>

          @if (selected(); as sel) {
            <div class="sb-detail" data-testid="sb-detail">
              <header class="sb-detail-head">
                <h4 class="sb-detail-name">{{ sel.name }}</h4>
                <span class="sb-detail-sub" data-testid="sb-detail-sub">
                  @if (sel.type === 'trigger') {
                    trigger@if (sel.on_table) { on <span class="sb-mono">{{ sel.on_table }}</span> }
                  } @else {
                    {{ sel.type }} · {{ sel.columns.length }} {{ sel.columns.length === 1 ? 'column' : 'columns' }}
                  }
                </span>
              </header>

              @if (sel.columns.length) {
                <div class="sb-scroll" tabindex="0" role="region" [attr.aria-label]="sel.name + ' columns'">
                  <table class="sb-cols" data-testid="sb-columns">
                    <thead>
                      <tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Nullable</th><th scope="col">Default</th><th scope="col">Key</th></tr>
                    </thead>
                    <tbody>
                      @for (col of sel.columns; track col.name) {
                        <tr data-testid="sb-col">
                          <td class="sb-col-name">{{ col.name }}</td>
                          <td class="sb-col-type">{{ col.type || '—' }}</td>
                          <td>{{ col.notnull ? 'NOT NULL' : 'nullable' }}</td>
                          <td class="sb-col-default">{{ col.dflt_value ?? '—' }}</td>
                          <td>@if (col.pk > 0) { <span class="sb-pk" data-testid="sb-pk" [title]="pkTitle(col.pk)">PK@if (isCompositePk()) {&nbsp;{{ col.pk }}}</span> }</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p class="sb-no-cols" data-testid="sb-no-cols">
                  @if (sel.type === 'trigger') {
                    This trigger has no columns — see its definition below.
                  } @else {
                    No columns.
                  }
                </p>
              }

              @if (isCompositePk()) {
                <div class="sb-section">
                  <div class="sb-section-h">Primary key</div>
                  <ul class="sb-meta-list">
                    <li data-testid="sb-pk-summary">
                      <span class="sb-tag">composite</span>
                      <span class="sb-dim">(</span><span class="sb-mono">{{ pkColumnsJoined() }}</span><span class="sb-dim">)</span>
                      <span class="sb-dim">— {{ primaryKey().length }} columns, order significant</span>
                    </li>
                  </ul>
                </div>
              }

              @if (sel.indexes.length) {
                <div class="sb-section">
                  <div class="sb-section-h">Indexes</div>
                  <ul class="sb-meta-list">
                    @for (ix of sel.indexes; track ix.name) {
                      <li data-testid="sb-index">
                        <span class="sb-mono">{{ ix.name }}</span>
                        @if (ix.unique) { <span class="sb-tag">unique</span> }
                        <span class="sb-dim">({{ ix.columns.join(', ') }})</span>
                      </li>
                    }
                  </ul>
                </div>
              }

              @if (sel.foreign_keys.length) {
                <div class="sb-section">
                  <div class="sb-section-h">Foreign keys</div>
                  <ul class="sb-meta-list">
                    @for (fk of sel.foreign_keys; track fk.from + fk.table + fk.to) {
                      <li data-testid="sb-fk">
                        <span class="sb-mono">{{ fk.from }}</span> →
                        <span class="sb-mono">{{ fk.table }}.{{ fk.to }}</span>
                        <span class="sb-dim">on delete {{ fk.on_delete || 'no action' }}</span>
                      </li>
                    }
                  </ul>
                </div>
              }

              @if (sel.create_sql; as ddl) {
                <div class="sb-section">
                  <div class="sb-section-h">
                    CREATE SQL
                    <button type="button" class="sb-copy" data-testid="sb-copy-ddl" (click)="copyDdl(ddl)">{{ copied() ? '✓ Copied' : 'Copy' }}</button>
                  </div>
                  <pre class="sb-ddl" data-testid="sb-ddl">{{ ddl }}</pre>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class SiteSchemaBrowserComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  /** The site whose schema to browse. Bound by the parent site-detail tab. */
  readonly siteId = input<string>('');

  readonly tables = signal<SchemaTable[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectedName = signal<string | null>(null);
  readonly search = signal('');
  readonly copied = signal(false);

  /** Tables filtered by the (case-insensitive) search box. */
  readonly filteredTables = computed(() => {
    const q = this.search().trim().toLowerCase();
    const all = this.tables();
    return q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
  });

  /** The currently-selected table object (or null). */
  readonly selected = computed(() => {
    const name = this.selectedName();
    return name ? (this.tables().find((t) => t.name === name) ?? null) : null;
  });

  /** PK columns of the selected object, in key order (`pk` = the 1-based position from
   *  PRAGMA table_info). A single such column is a normal PK; >1 is a COMPOSITE key whose
   *  column ORDER is significant, so we surface the position rather than a bare "PK". */
  readonly primaryKey = computed<{ name: string; pos: number }[]>(() =>
    (this.selected()?.columns ?? [])
      .filter((c) => c.pk > 0)
      .map((c) => ({ name: c.name, pos: c.pk }))
      .sort((a, b) => a.pos - b.pos),
  );

  /** True when the selected object's PK spans >1 column (an order-significant composite key). */
  readonly isCompositePk = computed(() => this.primaryKey().length > 1);

  /** The composite PK's columns in key order, e.g. `org_id, key` (for the summary line). */
  readonly pkColumnsJoined = computed(() => this.primaryKey().map((k) => k.name).join(', '));

  /** Tooltip for a PK badge — plain for a single-column key, position-aware for a composite. */
  pkTitle(pos: number): string {
    return this.isCompositePk()
      ? `Composite primary key — column ${pos} of ${this.primaryKey().length}`
      : 'Primary key';
  }

  ngOnInit(): void {
    this.load();
  }

  /** Fetch (or refresh) the schema. Public so the error card + Refresh can re-fire. */
  load(): void {
    const id = this.siteId();
    if (!id) return;
    this.loading.set(true);
    this.error.set(null);
    this.api
      .getSiteSchema(id)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        // Shape guard: a stale route can 200 with a shapeless body. Surface a
        // retryable error instead of a fake "empty schema".
        if (!res || !Array.isArray(res.data?.tables)) {
          this.tables.set([]);
          this.error.set('The schema response was unexpected — retry.');
          return;
        }
        this.tables.set(res.data.tables);
        // Keep the selection if it still exists, else land on the first table.
        const current = this.selectedName();
        if (!current || !res.data.tables.some((t) => t.name === current)) {
          this.selectedName.set(res.data.tables[0]?.name ?? null);
        }
      });
  }

  select(name: string): void {
    this.selectedName.set(name);
  }

  /** Copy a table's CREATE SQL to the clipboard (brief "✓ Copied" affordance). */
  copyDdl(ddl: string): void {
    void navigator.clipboard.writeText(ddl).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 1500);
      },
      () => undefined,
    );
  }
}
