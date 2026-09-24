/**
 * Site Data Browser — the "Data" tab body on `/admin/sites/:id`.
 *
 * An owner-facing, read-only browser for the site's REAL platform tables
 * (visitor events, form submissions, snapshots, MCP connections, content store).
 * Every surface is backed by a live, tenant-scoped endpoint — never mock data:
 *
 *  - `GET /api/sites/:siteId/data-overview`        → the table picker (row counts)
 *  - `GET /api/sites/:siteId/data-overview/:table` → one server-paginated page
 *
 * Both are org-scoped + IDOR-guarded server-side (404 on a foreign site), so this
 * is safe for a first-time site OWNER (unlike the super-admin SQL console next to
 * it). Pagination, sorting, and result size are all bounded server-side — the
 * browser never loads a whole table.
 *
 * Focused, single-responsibility, standalone component (Angular style guide):
 * signals + `input()` + native control flow, no lifecycle beyond a load on init.
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
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, of } from 'rxjs';
import { ApiService, type DataOverviewTable } from '../../../services/api.service';
import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';
import { ErrorCardComponent } from '../../../components/states';
import { toCsv, downloadText } from '../../../utils/csv-export';

@Component({
  selector: 'app-site-data-browser',
  standalone: true,
  imports: [CommonModule, FormsModule, MiniEmptyComponent, ErrorCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="db" data-testid="site-data-browser">
      @if (tablesLoading()) {
        <p class="db-loading" data-testid="db-tables-loading">Loading data tables…</p>
      } @else if (tablesError(); as err) {
        <app-error-card
          data-testid="db-tables-error"
          title="Couldn't load your data tables"
          [message]="err"
          (retry)="loadTables(siteId())"
        />
      } @else {
        <div class="db-tables" role="tablist" aria-label="Site data tables" data-testid="db-table-list">
          @for (t of tables(); track t.key) {
            <button
              type="button"
              role="tab"
              class="db-table-chip"
              [class.is-active]="selected()?.key === t.key"
              [attr.aria-selected]="selected()?.key === t.key"
              [attr.data-testid]="'db-table-' + t.key"
              (click)="selectTable(t)"
            >
              <span class="db-table-label">{{ t.label }}</span>
              <span class="db-table-count" [attr.title]="t.row_count + ' rows'">{{ t.row_count }}</span>
            </button>
          } @empty {
            <app-mini-empty text="No data tables for this site yet.">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
            </app-mini-empty>
          }
        </div>

        @if (selected(); as sel) {
          <p class="db-desc" data-testid="db-table-desc">
            {{ sel.description }}
            <span
              class="db-readonly-pill"
              data-testid="db-readonly-pill"
              title="Read-only — a curated view of your site's system & analytics tables. Row IDs aren't exposed here for safety, so rows can't be edited from this grid; edit your content in the site editor."
            >Read-only</span>
          </p>

          @if (rowsError(); as rerr) {
            <app-error-card
              class="block mb-3"
              data-testid="db-rows-error"
              title="Couldn't load rows"
              [message]="rerr"
              (retry)="loadPage()"
            />
          }

          <div class="db-toolbar">
            <input #sb type="search" class="db-search" data-testid="db-search"
                   [value]="search()"
                   (change)="setSearch(sb.value)"
                   (search)="setSearch(sb.value)"
                   placeholder="Search rows…"
                   aria-label="Search rows in this table" />
            <span class="db-range" data-testid="db-range">{{ rangeLabel() }}</span>
            <div class="db-pager" role="group" aria-label="Pagination">
              <button
                type="button"
                (click)="prevPage()"
                [disabled]="!canPrev() || rowsLoading()"
                data-testid="db-prev"
                aria-label="Previous page"
              >Prev</button>
              <button
                type="button"
                (click)="nextPage()"
                [disabled]="!canNext() || rowsLoading()"
                data-testid="db-next"
                aria-label="Next page"
              >Next</button>
            </div>
            <label class="db-pagesize">
              <span>Rows</span>
              <select
                [ngModel]="limit()"
                (ngModelChange)="setLimit($event)"
                aria-label="Rows per page"
                data-testid="db-pagesize"
              >
                <option [ngValue]="25">25</option>
                <option [ngValue]="50">50</option>
                <option [ngValue]="100">100</option>
              </select>
            </label>
            @if (columns().length > 1) {
              <details class="db-cols" data-testid="db-cols">
                <summary class="db-cols-summary" aria-label="Choose which columns to show">
                  Columns
                  @if (hiddenColumns().size > 0) {
                    <span class="db-cols-badge" data-testid="db-cols-badge">{{ visibleColumns().length }}/{{ columns().length }}</span>
                  }
                </summary>
                <div class="db-cols-menu" role="group" aria-label="Toggle table columns">
                  <button
                    type="button"
                    class="db-cols-all"
                    (click)="showAllColumns()"
                    [disabled]="hiddenColumns().size === 0"
                    data-testid="db-cols-all"
                  >Show all</button>
                  @for (col of columns(); track col) {
                    <label class="db-cols-item">
                      <input
                        type="checkbox"
                        [checked]="isColumnVisible(col)"
                        (change)="toggleColumn(col)"
                        [disabled]="isColumnVisible(col) && visibleColumns().length <= 1"
                        [attr.data-testid]="'db-col-toggle-' + col"
                      />
                      <span>{{ col }}</span>
                    </label>
                  }
                </div>
              </details>
            }
            <div class="db-actions">
              @if (exporting()) {
                <span class="db-exporting" aria-live="polite" data-testid="db-exporting">Exporting…</span>
              }
              <button
                type="button"
                class="db-export"
                (click)="exportCsv()"
                [disabled]="total() === 0 || exporting()"
                data-testid="db-export-csv"
                title="Download the whole table (up to 5,000 rows, current sort) as CSV"
                aria-label="Export the whole table as CSV"
              >CSV</button>
              <button
                type="button"
                class="db-export"
                (click)="exportJson()"
                [disabled]="total() === 0 || exporting()"
                data-testid="db-export-json"
                title="Download the whole table (up to 5,000 rows, current sort) as JSON"
                aria-label="Export the whole table as JSON"
              >JSON</button>
              <button
                type="button"
                class="db-refresh"
                (click)="refresh()"
                [disabled]="rowsLoading() || exporting()"
                data-testid="db-refresh"
                aria-label="Refresh rows"
              >{{ rowsLoading() ? 'Loading…' : 'Refresh' }}</button>
            </div>
          </div>
          @if (exportNote(); as note) {
            <p class="db-export-note" data-testid="db-export-note">{{ note }}</p>
          }

          @if (rowsLoading() && rows().length === 0) {
            <p class="db-loading" data-testid="db-rows-loading">Loading rows…</p>
          } @else if (rows().length === 0) {
            <app-mini-empty [text]="emptyText()" data-testid="db-rows-empty">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v4H3z"/><path d="M3 11h18M3 15h18M3 19h18"/></svg>
            </app-mini-empty>
          } @else {
            <div
              class="db-scroll"
              tabindex="0"
              role="region"
              [attr.aria-label]="sel.label + ' rows — scroll horizontally'"
            >
              <table class="db-table" data-testid="db-grid">
                <thead>
                  <tr>
                    @for (col of visibleColumns(); track col) {
                      <th scope="col" [attr.aria-sort]="ariaSort(col)">
                        <button
                          type="button"
                          class="db-sort"
                          (click)="sortBy(col)"
                          [attr.data-testid]="'db-sort-' + col"
                          [attr.aria-label]="'Sort by ' + col"
                        >
                          {{ col }}
                          @if (orderBy() === col) {
                            <span class="db-arrow" aria-hidden="true">{{ dir() === 'asc' ? '↑' : '↓' }}</span>
                          }
                        </button>
                      </th>
                    }
                    <th scope="col" class="db-detail-h" aria-label="Row detail"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows(); track $index) {
                    <tr [class.is-expanded]="expandedRow() === $index" data-testid="db-row">
                      @for (col of visibleColumns(); track col) {
                        <td data-testid="db-cell">
                          @if (row[col] === null || row[col] === undefined) {
                            <span class="db-null" title="NULL value">NULL</span>
                          } @else {
                            {{ formatCell(row[col]) }}
                          }
                        </td>
                      }
                      <td class="db-detail-c">
                        <button
                          type="button"
                          class="db-expand"
                          (click)="toggleRow($index)"
                          [attr.aria-expanded]="expandedRow() === $index"
                          [attr.data-testid]="'db-expand-' + $index"
                          [attr.aria-label]="expandedRow() === $index ? 'Hide row detail' : 'Show row detail'"
                        >{{ expandedRow() === $index ? '▾' : '▸' }}</button>
                      </td>
                    </tr>
                    @if (expandedRow() === $index) {
                      <tr class="db-detail-row" data-testid="db-detail">
                        <td [attr.colspan]="visibleColumns().length + 1">
                          <pre class="db-json">{{ rowJson(row) }}</pre>
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          }
        } @else {
          <app-mini-empty text="Select a table above to browse its rows.">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </app-mini-empty>
        }
      }
    </div>
  `,
  styles: [`
    .db { color: var(--ps-ink, #f4f4ff); }
    .db-loading { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-size: 0.85rem; }
    .db-tables { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1rem; }
    .db-table-chip {
      display: inline-flex; align-items: center; gap: 0.45rem; cursor: pointer;
      padding: 0.35rem 0.7rem; border-radius: 999px; font: inherit; font-size: 0.8rem;
      color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--ps-edge, rgba(255,255,255,0.08));
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .db-table-chip:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent); }
    .db-table-chip:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .db-table-chip.is-active {
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 45%, transparent);
    }
    .db-table-count {
      font-variant-numeric: tabular-nums; font-size: 0.72rem; font-weight: 600;
      padding: 0.05rem 0.4rem; border-radius: 999px;
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
    }
    .db-table-chip.is-active .db-table-count { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent); }
    .db-desc { margin: 0 0 0.75rem; font-size: 0.8rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .db-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.75rem; }
    .db-search {
      flex: 1 1 12rem; min-width: 8rem; max-width: 20rem;
      padding: 4px 10px; font-size: 0.78rem;
      background: rgba(255,255,255,0.06); color: var(--ps-ink, #f4f4ff);
      border: 1px solid rgba(255,255,255,0.14); border-radius: 8px;
    }
    .db-search:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    .db-range { font-size: 0.74rem; font-variant-numeric: tabular-nums; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .db-pager { display: inline-flex; gap: 0.35rem; }
    .db-pager button, .db-refresh, .db-export {
      font: inherit; font-size: 0.76rem; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 6px;
      color: var(--ps-accent, #00e5ff);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
    }
    .db-pager button:hover:not(:disabled), .db-refresh:hover:not(:disabled), .db-export:hover:not(:disabled) { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); }
    .db-pager button:disabled, .db-refresh:disabled, .db-export:disabled { opacity: 0.4; cursor: not-allowed; }
    .db-pager button:focus-visible, .db-refresh:focus-visible, .db-export:focus-visible, .db-pagesize select:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .db-pagesize { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.74rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent); }
    .db-pagesize select { font: inherit; font-size: 0.76rem; padding: 0.25rem 0.4rem; border-radius: 6px; color: inherit; background: rgba(0,0,0,0.25); border: 1px solid var(--ps-edge, rgba(255,255,255,0.12)); }
    .db-cols { position: relative; }
    .db-cols-summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.76rem; padding: 0.3rem 0.55rem; border-radius: 6px; color: inherit; background: rgba(0,0,0,0.25); border: 1px solid var(--ps-edge, rgba(255,255,255,0.12)); }
    .db-cols-summary::-webkit-details-marker { display: none; }
    .db-cols-summary:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); }
    .db-cols[open] > .db-cols-summary { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    .db-cols-summary:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .db-cols-badge { font-size: 0.62rem; font-weight: 700; padding: 0.05rem 0.3rem; border-radius: 999px; background: color-mix(in oklch, var(--ps-accent, #00e5ff) 24%, transparent); color: var(--ps-ink, #f4f4ff); }
    .db-cols-menu { position: absolute; z-index: 20; top: calc(100% + 0.35rem); left: 0; min-width: 12rem; max-height: 16rem; overflow-y: auto; display: grid; gap: 0.15rem; padding: 0.5rem; border-radius: 10px; background: var(--ps-surface, #12121c); border: 1px solid var(--ps-edge, rgba(255,255,255,0.14)); box-shadow: 0 12px 32px rgba(0,0,0,0.45); }
    .db-cols-all { font: inherit; font-size: 0.72rem; text-align: left; padding: 0.3rem 0.4rem; margin-bottom: 0.25rem; border-radius: 6px; color: var(--ps-accent, #00e5ff); background: transparent; border: 1px solid var(--ps-edge, rgba(255,255,255,0.12)); cursor: pointer; }
    .db-cols-all:hover:not(:disabled) { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent); }
    .db-cols-all:disabled { opacity: 0.4; cursor: not-allowed; }
    .db-cols-all:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .db-cols-item { display: flex; align-items: center; gap: 0.45rem; font-size: 0.76rem; padding: 0.25rem 0.4rem; border-radius: 6px; cursor: pointer; }
    .db-cols-item:hover { background: rgba(255,255,255,0.05); }
    .db-cols-item input { accent-color: var(--ps-accent, #00e5ff); }
    .db-cols-item input:disabled { cursor: not-allowed; }
    .db-cols-item input:disabled + span { opacity: 0.55; }
    .db-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 0.35rem; }
    .db-exporting { font-size: 0.72rem; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .db-export-note { margin: 0.4rem 0 0; font-size: 0.72rem; color: #ffc800; }
    .db-readonly-pill {
      margin-left: 0.5rem; font-size: 0.62rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 0.1rem 0.45rem; border-radius: 999px; cursor: help; white-space: nowrap;
      color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
      border: 1px solid var(--ps-edge, rgba(255,255,255,0.12));
    }
    .db-scroll { overflow-x: auto; max-width: 100%; border-radius: 8px; border: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); }
    .db-scroll:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .db-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .db-table th, .db-table td { text-align: left; padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--ps-edge, rgba(255,255,255,0.08)); white-space: nowrap; vertical-align: top; }
    .db-table thead th { position: sticky; top: 0; background: color-mix(in oklch, var(--ps-bg, #060610) 92%, transparent); backdrop-filter: blur(4px); }
    .db-sort {
      display: inline-flex; align-items: center; gap: 0.3rem; cursor: pointer; font: inherit;
      font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
      background: transparent; border: none; padding: 0;
    }
    .db-sort:hover { color: var(--ps-accent, #00e5ff); }
    .db-sort:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; border-radius: 3px; }
    .db-arrow { color: var(--ps-accent, #00e5ff); }
    .db-detail-h { width: 2.2rem; }
    .db-detail-c { text-align: center; }
    .db-null {
      font-size: 0.66rem; font-weight: 600; letter-spacing: 0.04em; padding: 0.05rem 0.35rem; border-radius: 4px;
      color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
    }
    .db-expand { cursor: pointer; font: inherit; background: transparent; border: none; color: var(--ps-accent, #00e5ff); padding: 0 0.2rem; line-height: 1; }
    .db-expand:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; border-radius: 3px; }
    tr.is-expanded { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 6%, transparent); }
    .db-detail-row td { background: rgba(0,0,0,0.28); }
    .db-json { margin: 0; padding: 0.6rem 0.75rem; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.76rem; white-space: pre-wrap; word-break: break-word; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); }
    .block { display: block; }
    .mb-3 { margin-bottom: 0.75rem; }
  `],
})
export class SiteDataBrowserComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  /** The site whose data to browse. Bound by the parent site-detail tab. */
  readonly siteId = input<string>('');

  // ── Table picker ─────────────────────────────────────────────────────
  readonly tables = signal<DataOverviewTable[]>([]);
  readonly tablesLoading = signal(false);
  readonly tablesError = signal<string | null>(null);
  readonly selected = signal<DataOverviewTable | null>(null);

  // ── Current page ─────────────────────────────────────────────────────
  readonly columns = signal<string[]>([]);
  /** Columns the owner has hidden from the grid (per-table, persisted). The row
   *  detail + CSV/JSON exports still include EVERY column, so hiding is a view-only
   *  scan aid that never loses or omits data. */
  readonly hiddenColumns = signal<ReadonlySet<string>>(new Set());
  /** Columns actually rendered in the grid = all columns minus the hidden set. */
  readonly visibleColumns = computed(() => this.columns().filter((c) => !this.hiddenColumns().has(c)));
  readonly rows = signal<Array<Record<string, unknown>>>([]);
  readonly total = signal(0);
  readonly limit = signal(25);
  readonly offset = signal(0);
  readonly orderBy = signal<string | null>(null);
  readonly dir = signal<'asc' | 'desc'>('desc');
  /** Server-side text search across the table's non-timestamp safe columns. */
  readonly search = signal('');
  readonly rowsLoading = signal(false);
  readonly rowsError = signal<string | null>(null);
  /** Index of the row whose full-JSON detail is expanded (single-open). */
  readonly expandedRow = signal<number | null>(null);

  /** "1–25 of 340" style range label; honest "0 of 0" on an empty table. */
  readonly rangeLabel = computed(() => {
    const t = this.total();
    if (t === 0) return '0 of 0';
    const start = this.offset() + 1;
    const end = this.offset() + this.rows().length;
    return `${start}–${end} of ${t}`;
  });
  readonly canPrev = computed(() => this.offset() > 0);
  readonly canNext = computed(() => this.offset() + this.limit() < this.total());
  /** Empty-state copy — distinguishes a page past the end from a truly empty table. */
  readonly emptyText = computed(() =>
    this.total() > 0
      ? 'No rows on this page — go back a page.'
      : 'No rows yet — this table is empty for your site.',
  );

  ngOnInit(): void {
    const id = this.siteId();
    if (id) this.loadTables(id);
  }

  /** Public so the error card's Retry can re-fire the overview load. */
  loadTables(id: string): void {
    if (!id) return;
    this.tablesLoading.set(true);
    this.tablesError.set(null);
    this.api
      .getDataOverview(id, { silent: true })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.tablesLoading.set(false);
        // Shape guard: a stale route can 200 with a shapeless body. Surface an
        // honest, retryable error instead of a fake "no tables" empty state.
        if (!res || !Array.isArray(res.data?.tables)) {
          this.tables.set([]);
          this.tablesError.set('The data overview response was unexpected — retry.');
          return;
        }
        this.tables.set(res.data.tables);
        // Launchpad default: open the first NON-empty table so the owner lands on
        // real rows, not a blank picker (empty states are first-action launchpads).
        if (!this.selected() && res.data.tables.length) {
          const first = res.data.tables.find((t) => t.row_count > 0) ?? res.data.tables[0];
          this.selectTable(first);
        }
      });
  }

  /** Switch the active table: reset paging + sort, then load its first page. */
  selectTable(t: DataOverviewTable): void {
    this.selected.set(t);
    this.columns.set(t.columns); // instant headers before the page lands
    this.loadHiddenColumns(); // restore this table's column-visibility preference
    this.offset.set(0);
    this.orderBy.set(null);
    this.dir.set('desc');
    this.search.set(''); // a new table starts unfiltered
    this.expandedRow.set(null);
    this.rowsError.set(null);
    this.loadPage();
  }

  /** Load the current window of the selected table. Public for Retry + refresh. */
  loadPage(): void {
    const sel = this.selected();
    const id = this.siteId();
    if (!sel || !id) return;
    this.rowsLoading.set(true);
    this.rowsError.set(null);
    this.expandedRow.set(null);
    this.api
      .browseDataTable(id, sel.key, {
        limit: this.limit(),
        offset: this.offset(),
        orderBy: this.orderBy() ?? undefined,
        dir: this.dir(),
        search: this.search() || undefined,
        silent: true,
      })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.rowsLoading.set(false);
        if (!res || !res.data || !Array.isArray(res.data.rows)) {
          this.rows.set([]);
          this.rowsError.set('Could not load rows — check your connection and retry.');
          return;
        }
        // Authoritative columns come from the response (identical to the spec's,
        // but the wire is the source of truth).
        this.columns.set(res.data.columns ?? sel.columns);
        this.rows.set(res.data.rows);
        this.total.set(res.total ?? res.data.rows.length);
        // Echo the server-applied window so the pager math matches reality.
        if (typeof res.limit === 'number') this.limit.set(res.limit);
        if (typeof res.offset === 'number') this.offset.set(res.offset);
      });
  }

  /** Apply a text search (server-side LIKE over the safe columns). Resets to page 1;
   *  no-op when the trimmed value is unchanged (avoids a redundant refetch on blur). */
  setSearch(value: string): void {
    const v = value.trim();
    if (v === this.search()) return;
    this.search.set(v);
    this.offset.set(0);
    this.loadPage();
  }

  /** Toggle sort on a column (asc → desc). Server re-validates the column. */
  sortBy(col: string): void {
    if (!this.columns().includes(col)) return;
    if (this.orderBy() === col) {
      this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.orderBy.set(col);
      this.dir.set('asc');
    }
    this.offset.set(0);
    this.loadPage();
  }

  /** `aria-sort` value for a column header (WCAG — sortable column semantics). */
  ariaSort(col: string): 'none' | 'ascending' | 'descending' {
    if (this.orderBy() !== col) return 'none';
    return this.dir() === 'asc' ? 'ascending' : 'descending';
  }

  /** Whether a column is currently shown in the grid. */
  isColumnVisible(col: string): boolean {
    return !this.hiddenColumns().has(col);
  }

  /** Show/hide a column in the grid. Refuses to hide the LAST visible column (an
   *  all-hidden grid is a dead end); the detail view + exports are unaffected.
   *  Preference is persisted per (site, table). */
  toggleColumn(col: string): void {
    const next = new Set(this.hiddenColumns());
    if (next.has(col)) {
      next.delete(col);
    } else {
      if (this.visibleColumns().length <= 1) return; // never hide the last one
      next.add(col);
    }
    this.hiddenColumns.set(next);
    this.persistHiddenColumns(next);
  }

  /** Reveal every column again (resets the per-table hidden set). */
  showAllColumns(): void {
    this.hiddenColumns.set(new Set());
    this.persistHiddenColumns(new Set());
  }

  /** localStorage key for the current table's hidden-column set. */
  private colsStorageKey(): string {
    return `ps_datacols_hidden_${this.siteId()}_${this.selected()?.key ?? ''}`;
  }

  /** Restore the persisted hidden-column set for the active table (fail-soft:
   *  private mode / bad JSON → show all columns). */
  private loadHiddenColumns(): void {
    try {
      const raw = localStorage.getItem(this.colsStorageKey());
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      const cols = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      this.hiddenColumns.set(new Set(cols));
    } catch {
      this.hiddenColumns.set(new Set());
    }
  }

  /** Persist the hidden-column set for the active table (fail-soft on quota/private mode). */
  private persistHiddenColumns(next: ReadonlySet<string>): void {
    try {
      localStorage.setItem(this.colsStorageKey(), JSON.stringify([...next]));
    } catch {
      /* private mode / quota — the in-memory signal still drives the view this session */
    }
  }

  nextPage(): void {
    if (!this.canNext() || this.rowsLoading()) return;
    this.offset.set(this.offset() + this.limit());
    this.loadPage();
  }

  prevPage(): void {
    if (!this.canPrev() || this.rowsLoading()) return;
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.loadPage();
  }

  /** Change the page size — reset to the first page so the window stays valid. */
  setLimit(n: number): void {
    const next = Number(n);
    if (!Number.isFinite(next) || next <= 0) return;
    this.limit.set(next);
    this.offset.set(0);
    this.loadPage();
  }

  refresh(): void {
    this.loadPage();
  }

  /** True while a full-table export is fetching pages (disables the buttons). */
  readonly exporting = signal(false);
  /** Honest note after an export (only set when the export was capped); else null. */
  readonly exportNote = signal<string | null>(null);
  /** Hard cap on a client-side full-table export — bounds cost + request count. */
  private static readonly EXPORT_CAP = 5000;
  private static readonly EXPORT_PAGE = 100;

  /**
   * Fetch up to {@link EXPORT_CAP} rows of the selected table across pages
   * (respecting the current sort), so an export is the WHOLE table, not just the
   * visible page — but still bounded (never loads an unbounded table into the
   * browser). Sets {@link exportNote} when the cap truncates the result.
   */
  private async collectAllRows(): Promise<Array<Record<string, unknown>>> {
    const sel = this.selected();
    const id = this.siteId();
    if (!sel || !id) return [];
    const cap = SiteDataBrowserComponent.EXPORT_CAP;
    const pageSize = SiteDataBrowserComponent.EXPORT_PAGE;
    const out: Array<Record<string, unknown>> = [];
    let offset = 0;
    let total = this.total();
    while (out.length < cap) {
      const page = await firstValueFrom(
        this.api
          .browseDataTable(id, sel.key, {
            limit: pageSize,
            offset,
            orderBy: this.orderBy() ?? undefined,
            dir: this.dir(),
            silent: true,
          })
          .pipe(catchError(() => of(null))),
      );
      const rows = page?.data?.rows ?? [];
      if (rows.length === 0) break; // error or genuine end
      out.push(...rows);
      offset += rows.length;
      total = page?.total ?? total;
      if (offset >= total || rows.length < pageSize) break; // last page reached
    }
    const capped = out.length >= cap && total > cap;
    this.exportNote.set(
      capped
        ? `Exported the first ${cap.toLocaleString()} of ${total.toLocaleString()} rows (export is capped).`
        : null,
    );
    return out.slice(0, cap);
  }

  /** `{site}-{table}-{rowCount}rows` — names the exact row count the file holds. */
  private exportBaseName(count: number): string {
    const table = this.selected()?.key ?? 'data';
    return `${this.siteId() || 'site'}-${table}-${count}rows`;
  }

  /** Fetch the whole table (bounded) and download it in the chosen format. */
  private async runExport(format: 'csv' | 'json'): Promise<void> {
    if (this.total() === 0 || this.exporting()) return;
    this.exporting.set(true);
    this.exportNote.set(null);
    try {
      const rows = await this.collectAllRows();
      if (rows.length === 0) return;
      const name = this.exportBaseName(rows.length);
      if (format === 'csv') {
        downloadText(`${name}.csv`, toCsv(rows, this.columns()), 'text/csv;charset=utf-8');
      } else {
        downloadText(`${name}.json`, JSON.stringify(rows, null, 2), 'application/json');
      }
    } finally {
      this.exporting.set(false);
    }
  }

  /** Download the whole table (up to the cap, current sort) as CSV. */
  exportCsv(): Promise<void> {
    return this.runExport('csv');
  }

  /** Download the whole table (up to the cap, current sort) as pretty JSON. */
  exportJson(): Promise<void> {
    return this.runExport('json');
  }

  toggleRow(index: number): void {
    this.expandedRow.set(this.expandedRow() === index ? null : index);
  }

  /**
   * Render a cell value: objects → compact JSON, everything else → string.
   * `null`/`undefined` are handled in the template (a NULL badge), never here.
   */
  formatCell(value: unknown): string {
    if (value !== null && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  /** Pretty-print the whole row for the expandable detail panel. */
  rowJson(row: Record<string, unknown>): string {
    try {
      return JSON.stringify(row, null, 2);
    } catch {
      return String(row);
    }
  }
}
