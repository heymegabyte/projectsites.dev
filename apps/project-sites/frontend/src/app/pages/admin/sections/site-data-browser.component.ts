/**
 * Site Data Browser — the "Data" tab body on `/admin/sites/:id`.
 *
 * An owner-facing browser for the site's REAL platform tables (visitor events,
 * form submissions, snapshots, MCP connections, content store). Browsing is
 * read-only; DELETABLE / EDITABLE tables (currently Form Submissions) also let the
 * owner delete their OWN rows and edit allowlisted typed columns (e.g. a lead's
 * `status`). Every surface is backed by a live, tenant-scoped endpoint — never mock:
 *
 *  - `GET    /api/sites/:siteId/data-overview`               → table picker (row counts)
 *  - `GET    /api/sites/:siteId/data-overview/:table`        → one server-paginated page
 *  - `DELETE /api/sites/:siteId/data-overview/:table/:rowId` → delete one own row (allowlisted)
 *  - `PATCH  /api/sites/:siteId/data-overview/:table/:rowId` → edit one allowlisted typed column
 *  - `GET    /api/sites/:siteId/data-activity`               → recent data mutations (audit trail)
 *
 * All are org-scoped + IDOR-guarded server-side (404 on a foreign site), so this
 * is safe for a first-time site OWNER (unlike the super-admin SQL console next to
 * it). Pagination, sorting, and result size are all bounded server-side — the
 * browser never loads a whole table. Delete + edit require an explicit confirmation
 * and only fire against a stable-`id` row; the server re-checks the allowlist +
 * validates the value (delete is irreversible; a status edit is reversible).
 *
 * Focused, single-responsibility, standalone component (Angular style guide):
 * signals + `input()` + native control flow, no lifecycle beyond a load on init.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, of } from 'rxjs';
import {
  ApiService,
  type DataOverviewTable,
  type DataActivityEvent,
} from '../../../services/api.service';
import { ConfirmService } from '../../../services/confirm.service';
import { ToastService } from '../../../services/toast.service';
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
        @if (dataSummary(); as s) {
          <p class="db-summary" data-testid="db-summary" aria-live="polite">
            <strong>{{ s.tableCount }}</strong> {{ s.tableCount === 1 ? 'table' : 'tables' }} ·
            <strong>{{ s.totalRows.toLocaleString() }}</strong>
            {{ s.totalRows === 1 ? 'record' : 'records' }}
            @if (s.largest && s.largest.row_count > 0) {
              · largest: <strong>{{ s.largest.label }}</strong> ({{
                s.largest.row_count.toLocaleString()
              }})
            }
          </p>
        }
        <div
          class="db-tables"
          role="tablist"
          aria-label="Site data tables"
          data-testid="db-table-list"
        >
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
              <span class="db-table-count" [attr.title]="t.row_count + ' rows'">{{
                t.row_count
              }}</span>
              @if (compactAge(t.last_activity); as age) {
                <span
                  class="db-table-fresh"
                  [attr.data-testid]="'db-table-fresh-' + t.key"
                  [attr.title]="'Last activity: ' + fullTimestamp(t.last_activity)"
                  >{{ age }}</span
                >
              }
            </button>
          } @empty {
            <app-mini-empty text="No data tables for this site yet.">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                <path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
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
              >Read-only</span
            >
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
            <input
              #sb
              type="search"
              class="db-search"
              data-testid="db-search"
              [value]="search()"
              (change)="setSearch(sb.value)"
              (search)="setSearch(sb.value)"
              placeholder="Search rows…"
              aria-label="Search rows in this table"
            />
            <div
              class="db-colfilter"
              role="group"
              aria-label="Filter by an exact column value"
              data-testid="db-colfilter"
            >
              <select
                #fc
                class="db-colfilter-sel"
                [value]="filterCol()"
                (change)="onFilterColChange(fc.value, fv.value)"
                data-testid="db-colfilter-col"
                aria-label="Filter column"
              >
                <option value="">Filter column…</option>
                @for (col of columns(); track col) {
                  <option [value]="col">{{ col }}</option>
                }
              </select>
              <input
                #fv
                type="text"
                class="db-colfilter-val"
                [value]="filterVal()"
                [disabled]="!fc.value"
                placeholder="exact value"
                (change)="applyColumnFilter(fc.value, fv.value)"
                (keydown.enter)="applyColumnFilter(fc.value, fv.value)"
                data-testid="db-colfilter-val"
                aria-label="Exact filter value"
              />
              @if (filterCol() && filterVal()) {
                <button
                  type="button"
                  class="db-colfilter-clear"
                  (click)="clearColumnFilter()"
                  data-testid="db-colfilter-clear"
                  aria-label="Clear column filter"
                  title="Clear filter"
                >
                  ×
                </button>
              }
            </div>
            <span class="db-range" data-testid="db-range">{{ rangeLabel() }}</span>
            <div class="db-pager" role="group" aria-label="Pagination">
              <button
                type="button"
                (click)="prevPage()"
                [disabled]="!canPrev() || rowsLoading()"
                data-testid="db-prev"
                aria-label="Previous page"
              >
                Prev
              </button>
              <button
                type="button"
                (click)="nextPage()"
                [disabled]="!canNext() || rowsLoading()"
                data-testid="db-next"
                aria-label="Next page"
              >
                Next
              </button>
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
                    <span class="db-cols-badge" data-testid="db-cols-badge"
                      >{{ visibleColumns().length }}/{{ columns().length }}</span
                    >
                  }
                </summary>
                <div class="db-cols-menu" role="group" aria-label="Toggle table columns">
                  <button
                    type="button"
                    class="db-cols-all"
                    (click)="showAllColumns()"
                    [disabled]="hiddenColumns().size === 0"
                    data-testid="db-cols-all"
                  >
                    Show all
                  </button>
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
              @if (copied(); as msg) {
                <span class="db-copied" aria-live="polite" data-testid="db-copied"
                  >✓ {{ msg }}</span
                >
              }
              @if (exporting()) {
                <span class="db-exporting" aria-live="polite" data-testid="db-exporting"
                  >Exporting…</span
                >
              }
              <button
                type="button"
                class="db-export"
                (click)="exportCsv()"
                [disabled]="total() === 0 || exporting()"
                data-testid="db-export-csv"
                [title]="
                  (filterActive() ? 'Download the filtered rows' : 'Download the whole table') +
                  ' (up to 5,000 rows, current sort) as CSV'
                "
                [attr.aria-label]="
                  (filterActive() ? 'Export the filtered rows' : 'Export the whole table') +
                  ' as CSV'
                "
              >
                CSV
              </button>
              <button
                type="button"
                class="db-export"
                (click)="exportJson()"
                [disabled]="total() === 0 || exporting()"
                data-testid="db-export-json"
                [title]="
                  (filterActive() ? 'Download the filtered rows' : 'Download the whole table') +
                  ' (up to 5,000 rows, current sort) as JSON'
                "
                [attr.aria-label]="
                  (filterActive() ? 'Export the filtered rows' : 'Export the whole table') +
                  ' as JSON'
                "
              >
                JSON
              </button>
              <button
                type="button"
                class="db-refresh"
                (click)="refresh()"
                [disabled]="rowsLoading() || exporting()"
                data-testid="db-refresh"
                aria-label="Refresh rows"
              >
                {{ rowsLoading() ? 'Loading…' : 'Refresh' }}
              </button>
            </div>
          </div>
          @if (exportNote(); as note) {
            <p class="db-export-note" data-testid="db-export-note">{{ note }}</p>
          }

          @if (rowsLoading() && rows().length === 0) {
            <p class="db-loading" data-testid="db-rows-loading">Loading rows…</p>
          } @else if (rows().length === 0) {
            <app-mini-empty [text]="emptyText()" data-testid="db-rows-empty">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 3h18v4H3z" />
                <path d="M3 11h18M3 15h18M3 19h18" />
              </svg>
            </app-mini-empty>
          } @else {
            @if (selectedCount() > 0) {
              <div
                class="db-bulk-bar"
                role="region"
                aria-label="Bulk actions"
                data-testid="db-bulk-bar"
              >
                <span class="db-bulk-count" aria-live="polite">{{ selectedCount() }} selected</span>
                <button
                  type="button"
                  class="db-bulk-delete"
                  (click)="bulkDelete()"
                  [disabled]="bulkDeleting()"
                  data-testid="db-bulk-delete"
                >
                  {{ bulkDeleting() ? 'Deleting…' : 'Delete selected' }}
                </button>
                <button
                  type="button"
                  class="db-bulk-clear"
                  (click)="clearSelection()"
                  [disabled]="bulkDeleting()"
                  data-testid="db-bulk-clear"
                >
                  Clear
                </button>
              </div>
            }
            <div
              class="db-scroll"
              tabindex="0"
              role="region"
              [attr.aria-label]="sel.label + ' rows — scroll horizontally'"
            >
              <table class="db-table" data-testid="db-grid">
                <thead>
                  <tr>
                    @if (selected()?.deletable) {
                      <th scope="col" class="db-sel-h">
                        <input
                          type="checkbox"
                          class="db-sel-all"
                          [checked]="allPageSelected()"
                          (change)="toggleSelectAllPage()"
                          data-testid="db-select-all"
                          aria-label="Select all rows on this page"
                        />
                      </th>
                    }
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
                            <span class="db-arrow" aria-hidden="true">{{
                              dir() === 'asc' ? '↑' : '↓'
                            }}</span>
                          }
                        </button>
                      </th>
                    }
                    <th scope="col" class="db-detail-h" aria-label="Row detail"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of rows(); track $index; let rowIndex = $index) {
                    <tr [class.is-expanded]="expandedRow() === $index" data-testid="db-row">
                      @if (selected()?.deletable) {
                        <td class="db-sel-c">
                          @if (isString(row['id'])) {
                            <input
                              type="checkbox"
                              class="db-sel"
                              [checked]="isRowSelected(row)"
                              (change)="toggleRowSelected(row)"
                              [attr.data-testid]="'db-select-' + $index"
                              [attr.aria-label]="'Select row ' + ($index + 1)"
                            />
                          }
                        </td>
                      }
                      @for (col of visibleColumns(); track col) {
                        <td
                          data-testid="db-cell"
                          [class.db-cell-editable]="isCellEditable(col, row)"
                        >
                          @if (isEditingCell(rowIndex, col)) {
                            <!-- Inline editor (in place) — enum → select, text → input. Commits
                                 via the same confirmed, audited PATCH as the detail panel. -->
                            @if (editableSpecFor(col)?.type === 'enum') {
                              <select
                                class="db-cell-editor"
                                [attr.data-testid]="'db-cell-edit-' + rowIndex + '-' + col"
                                [attr.aria-label]="'Edit ' + col"
                                [value]="cellEdit()?.value"
                                (change)="onCellSelectChange(row, $any($event.target).value)"
                                (keydown.escape)="cancelCellEdit()"
                                (blur)="onCellSelectBlur()"
                              >
                                @for (opt of editableSpecFor(col)!.options; track opt) {
                                  <option [value]="opt" [selected]="cellEdit()?.value === opt">
                                    {{ opt }}
                                  </option>
                                }
                              </select>
                            } @else {
                              <input
                                class="db-cell-editor"
                                type="text"
                                [attr.data-testid]="'db-cell-edit-' + rowIndex + '-' + col"
                                [attr.aria-label]="'Edit ' + col"
                                [value]="cellEdit()?.value"
                                [attr.maxlength]="editableSpecFor(col)?.maxLength || null"
                                (input)="setCellDraft($any($event.target).value)"
                                (keydown.enter)="commitCellEdit(row)"
                                (keydown.escape)="cancelCellEdit()"
                                (blur)="commitCellEdit(row)"
                              />
                            }
                          } @else if (isCellEditable(col, row)) {
                            <!-- Editable cell: click / Enter / double-click opens the inline
                                 editor. Keyboard-accessible (native button) + a11y label. -->
                            <button
                              type="button"
                              class="db-cell-edit-trigger"
                              (click)="startCellEdit(rowIndex, col, row)"
                              (dblclick)="startCellEdit(rowIndex, col, row)"
                              [attr.data-testid]="'db-cell-trigger-' + rowIndex + '-' + col"
                              [attr.aria-label]="
                                'Edit ' + col + ' (currently ' + formatCell(row[col]) + ')'
                              "
                              title="Click to edit"
                            >
                              @if (row[col] === null || row[col] === undefined) {
                                <span class="db-null" aria-label="null">—</span>
                              } @else {
                                {{ formatCell(row[col]) }}
                              }
                              <span class="db-cell-pencil" aria-hidden="true">✎</span>
                            </button>
                          } @else if (row[col] === null || row[col] === undefined) {
                            <span class="db-null" title="NULL — no value stored" aria-label="null"
                              >—</span
                            >
                          } @else {
                            <button
                              type="button"
                              class="db-cell-copy"
                              (click)="copyValue(row[col])"
                              [attr.data-testid]="'db-copy-' + col"
                              title="Click to copy this value"
                            >
                              {{ formatCell(row[col]) }}
                            </button>
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
                          [attr.aria-label]="
                            expandedRow() === $index ? 'Hide row detail' : 'Show row detail'
                          "
                        >
                          {{ expandedRow() === $index ? '▾' : '▸' }}
                        </button>
                      </td>
                    </tr>
                    @if (expandedRow() === $index) {
                      <tr class="db-detail-row" data-testid="db-detail">
                        <td
                          [attr.colspan]="
                            visibleColumns().length + 1 + (selected()?.deletable ? 1 : 0)
                          "
                        >
                          <div class="db-detail-bar">
                            @if (selected()?.deletable && isString(row['id'])) {
                              <button
                                type="button"
                                class="db-delete-row"
                                (click)="deleteRow(row)"
                                [disabled]="deletingId() === row['id']"
                                data-testid="db-delete-row"
                                aria-label="Delete this row permanently"
                              >
                                {{ deletingId() === row['id'] ? 'Deleting…' : 'Delete row' }}
                              </button>
                            }
                            <button
                              type="button"
                              class="db-copy-row"
                              (click)="copyRow(row)"
                              data-testid="db-copy-row"
                              aria-label="Copy this row as JSON"
                            >
                              Copy JSON
                            </button>
                          </div>
                          @if (editableColumnsList().length && isString(row['id'])) {
                            <div class="db-edit" data-testid="db-edit">
                              @for (ec of editableColumnsList(); track ec.column) {
                                <div class="db-edit-field">
                                  <label
                                    class="db-edit-label"
                                    [attr.for]="'db-edit-' + ec.column"
                                    >{{ ec.column }}</label
                                  >
                                  @if (ec.type === 'enum') {
                                    <select
                                      class="db-edit-select"
                                      [id]="'db-edit-' + ec.column"
                                      [attr.data-testid]="'db-edit-' + ec.column"
                                      [value]="draftValue(row, ec.column)"
                                      (change)="setDraft(ec.column, $any($event.target).value)"
                                    >
                                      @for (opt of ec.options; track opt) {
                                        <option
                                          [value]="opt"
                                          [selected]="draftValue(row, ec.column) === opt"
                                        >
                                          {{ opt }}
                                        </option>
                                      }
                                    </select>
                                  } @else if (ec.type === 'text') {
                                    <textarea
                                      class="db-edit-textarea"
                                      [id]="'db-edit-' + ec.column"
                                      [attr.data-testid]="'db-edit-' + ec.column"
                                      [value]="draftValue(row, ec.column)"
                                      (input)="setDraft(ec.column, $any($event.target).value)"
                                      [attr.maxlength]="ec.maxLength || null"
                                      rows="2"
                                      placeholder="Add a private note…"
                                    ></textarea>
                                  }
                                  <button
                                    type="button"
                                    class="db-edit-save"
                                    [disabled]="!isEdited(row, ec.column) || savingEdit()"
                                    (click)="saveEdit(row, ec.column)"
                                    [attr.data-testid]="'db-edit-save-' + ec.column"
                                    [attr.aria-label]="'Save ' + ec.column"
                                  >
                                    {{ savingEdit() ? 'Saving…' : 'Save' }}
                                  </button>
                                </div>
                              }
                            </div>
                          }
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
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </app-mini-empty>
        }
      }

      <!-- Recent activity — the owner's OWN data mutations (deletes/edits) from this
           browser, from the append-only audit log. Read-only; collapsed by default. -->
      @if (activity().length) {
        <details class="db-activity" data-testid="db-activity">
          <summary class="db-activity-summary">
            Recent activity
            <span class="db-activity-count">{{ activity().length }}</span>
          </summary>
          <ul class="db-activity-list">
            @for (ev of activity(); track $index) {
              <li class="db-activity-item" data-testid="db-activity-item">
                <span class="db-activity-icon" [attr.data-action]="ev.action" aria-hidden="true">{{
                  ev.action === 'site_data.row_deleted' ? '✕' : '✎'
                }}</span>
                <span class="db-activity-msg">{{ ev.message }}</span>
                <span class="db-activity-age" [attr.title]="fullTimestamp(ev.at)">{{
                  compactAge(ev.at)
                }}</span>
              </li>
            }
          </ul>
        </details>
      }
    </div>
  `,
  styles: [
    `
      .db {
        color: var(--ps-ink, #f4f4ff);
      }
      .db-loading {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        font-size: 0.85rem;
      }
      .db-summary {
        margin: 0 0 0.6rem;
        font-size: 0.74rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
      }
      .db-summary strong {
        color: var(--ps-ink, #f4f4ff);
        font-variant-numeric: tabular-nums;
      }
      .db-tables {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-bottom: 1rem;
      }
      .db-table-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        cursor: pointer;
        padding: 0.35rem 0.7rem;
        border-radius: 999px;
        font: inherit;
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
        transition:
          background 140ms ease,
          border-color 140ms ease,
          color 140ms ease;
      }
      .db-table-chip:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
      }
      .db-table-chip:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-table-chip.is-active {
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 45%, transparent);
      }
      .db-table-count {
        font-variant-numeric: tabular-nums;
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
      }
      .db-table-chip.is-active .db-table-count {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
      }
      .db-table-fresh {
        font-variant-numeric: tabular-nums;
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 48%, transparent);
      }
      .db-activity {
        margin-top: 1.1rem;
        border-top: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
        padding-top: 0.7rem;
      }
      .db-activity-summary {
        cursor: pointer;
        font-size: 0.72rem;
        font-weight: 600;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        display: flex;
        align-items: center;
        gap: 0.4rem;
        list-style: none;
      }
      .db-activity-summary::-webkit-details-marker {
        display: none;
      }
      .db-activity-summary::before {
        content: '▸';
        font-size: 0.7rem;
        transition: transform 150ms ease;
      }
      .db-activity[open] .db-activity-summary::before {
        transform: rotate(90deg);
      }
      .db-activity-count {
        font-variant-numeric: tabular-nums;
        font-size: 0.62rem;
        font-weight: 700;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
      }
      .db-activity-list {
        list-style: none;
        margin: 0.6rem 0 0;
        padding: 0;
        display: grid;
        gap: 0.35rem;
      }
      .db-activity-item {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        font-size: 0.76rem;
      }
      .db-activity-icon {
        flex-shrink: 0;
        width: 1.1rem;
        text-align: center;
        font-size: 0.72rem;
      }
      .db-activity-icon[data-action='site_data.row_deleted'] {
        color: #ff8f9a;
      }
      .db-activity-icon[data-action='site_data.row_updated'] {
        color: var(--ps-accent, #00e5ff);
      }
      .db-activity-msg {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 85%, transparent);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .db-activity-age {
        margin-left: auto;
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
        font-size: 0.66rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      }
      .db-desc {
        margin: 0 0 0.75rem;
        font-size: 0.8rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
      }
      .db-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
      }
      .db-search {
        flex: 1 1 12rem;
        min-width: 8rem;
        max-width: 20rem;
        padding: 4px 10px;
        font-size: 0.78rem;
        background: rgba(255, 255, 255, 0.06);
        color: var(--ps-ink, #f4f4ff);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
      }
      .db-search:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      .db-colfilter {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }
      .db-colfilter-sel,
      .db-colfilter-val {
        padding: 4px 8px;
        font-size: 0.76rem;
        background: rgba(255, 255, 255, 0.06);
        color: var(--ps-ink, #f4f4ff);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
      }
      .db-colfilter-val {
        width: 8rem;
      }
      .db-colfilter-val:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .db-colfilter-sel:focus-visible,
      .db-colfilter-val:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      .db-colfilter-clear {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.4rem;
        height: 1.4rem;
        font-size: 1rem;
        line-height: 1;
        color: var(--ps-ink, #f4f4ff);
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        cursor: pointer;
      }
      .db-colfilter-clear:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
      }
      .db-colfilter-clear:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-range {
        font-size: 0.74rem;
        font-variant-numeric: tabular-nums;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
      }
      .db-pager {
        display: inline-flex;
        gap: 0.35rem;
      }
      .db-pager button,
      .db-refresh,
      .db-export {
        font: inherit;
        font-size: 0.76rem;
        cursor: pointer;
        padding: 0.3rem 0.7rem;
        border-radius: 6px;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
      }
      .db-pager button:hover:not(:disabled),
      .db-refresh:hover:not(:disabled),
      .db-export:hover:not(:disabled) {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
      }
      .db-pager button:disabled,
      .db-refresh:disabled,
      .db-export:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .db-pager button:focus-visible,
      .db-refresh:focus-visible,
      .db-export:focus-visible,
      .db-pagesize select:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-pagesize {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.74rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
      }
      .db-pagesize select {
        font: inherit;
        font-size: 0.76rem;
        padding: 0.25rem 0.4rem;
        border-radius: 6px;
        color: inherit;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.12));
      }
      .db-cols {
        position: relative;
      }
      .db-cols-summary {
        list-style: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.76rem;
        padding: 0.3rem 0.55rem;
        border-radius: 6px;
        color: inherit;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.12));
      }
      .db-cols-summary::-webkit-details-marker {
        display: none;
      }
      .db-cols-summary:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
      }
      .db-cols[open] > .db-cols-summary {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      .db-cols-summary:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-cols-badge {
        font-size: 0.62rem;
        font-weight: 700;
        padding: 0.05rem 0.3rem;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 24%, transparent);
        color: var(--ps-ink, #f4f4ff);
      }
      .db-cols-menu {
        position: absolute;
        z-index: 20;
        top: calc(100% + 0.35rem);
        left: 0;
        min-width: 12rem;
        max-height: 16rem;
        overflow-y: auto;
        display: grid;
        gap: 0.15rem;
        padding: 0.5rem;
        border-radius: 10px;
        background: var(--ps-surface, #12121c);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.14));
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      }
      .db-cols-all {
        font: inherit;
        font-size: 0.72rem;
        text-align: left;
        padding: 0.3rem 0.4rem;
        margin-bottom: 0.25rem;
        border-radius: 6px;
        color: var(--ps-accent, #00e5ff);
        background: transparent;
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.12));
        cursor: pointer;
      }
      .db-cols-all:hover:not(:disabled) {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent);
      }
      .db-cols-all:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .db-cols-all:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-cols-item {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        font-size: 0.76rem;
        padding: 0.25rem 0.4rem;
        border-radius: 6px;
        cursor: pointer;
      }
      .db-cols-item:hover {
        background: rgba(255, 255, 255, 0.05);
      }
      .db-cols-item input {
        accent-color: var(--ps-accent, #00e5ff);
      }
      .db-cols-item input:disabled {
        cursor: not-allowed;
      }
      .db-cols-item input:disabled + span {
        opacity: 0.55;
      }
      .db-actions {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      .db-exporting {
        font-size: 0.72rem;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
      }
      .db-copied {
        font-size: 0.72rem;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
      }
      .db-cell-copy {
        font: inherit;
        color: inherit;
        background: none;
        border: 0;
        padding: 0;
        margin: 0;
        text-align: left;
        cursor: copy;
        max-width: 22rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: inline-block;
        vertical-align: bottom;
      }
      .db-cell-copy:hover {
        color: var(--ps-accent, #00e5ff);
        text-decoration: underline dotted;
      }
      .db-cell-copy:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
        border-radius: 3px;
      }
      /* Inline-editable cell: an edit-trigger button that reveals a pencil on hover/focus. */
      .db-cell-edit-trigger {
        font: inherit;
        color: inherit;
        background: none;
        border: 0;
        padding: 0.05rem 0.3rem;
        margin: -0.05rem -0.15rem;
        text-align: left;
        cursor: text;
        max-width: 22rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        border-radius: 4px;
        vertical-align: bottom;
      }
      .db-cell-edit-trigger:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        color: var(--ps-accent, #00e5ff);
      }
      .db-cell-edit-trigger:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      .db-cell-pencil {
        opacity: 0;
        font-size: 0.72em;
        color: var(--ps-accent, #00e5ff);
        transition: opacity 0.12s ease;
      }
      .db-cell-edit-trigger:hover .db-cell-pencil,
      .db-cell-edit-trigger:focus-visible .db-cell-pencil {
        opacity: 0.9;
      }
      /* Inline editor (select/input) shown in place of the value while editing a cell. */
      .db-cell-editor {
        font: inherit;
        color: var(--ps-ink, #f4f4ff);
        background: var(--ps-bg, #060610);
        border: 1px solid var(--ps-accent, #00e5ff);
        border-radius: 4px;
        padding: 0.1rem 0.3rem;
        max-width: 22rem;
        width: 100%;
        box-sizing: border-box;
      }
      .db-cell-editor:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      .db-detail-bar {
        display: flex;
        justify-content: flex-end;
        gap: 0.4rem;
        margin-bottom: 0.4rem;
      }
      .db-copy-row {
        font: inherit;
        font-size: 0.72rem;
        padding: 0.25rem 0.55rem;
        border-radius: 6px;
        color: var(--ps-accent, #00e5ff);
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.14));
        cursor: pointer;
      }
      .db-copy-row:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent);
      }
      .db-copy-row:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-delete-row {
        font: inherit;
        font-size: 0.72rem;
        padding: 0.25rem 0.55rem;
        border-radius: 6px;
        color: #ff8f9a;
        background: color-mix(in oklch, #ff6b6b 12%, transparent);
        border: 1px solid color-mix(in oklch, #ff6b6b 34%, transparent);
        cursor: pointer;
      }
      .db-delete-row:hover:not(:disabled) {
        background: color-mix(in oklch, #ff6b6b 22%, transparent);
        color: #fff;
      }
      .db-delete-row:focus-visible {
        outline: 2px solid #ff6b6b;
        outline-offset: 2px;
      }
      .db-delete-row:disabled {
        opacity: 0.6;
        cursor: progress;
      }
      .db-sel-h,
      .db-sel-c {
        width: 1.8rem;
        text-align: center;
        padding: 0 0.3rem;
      }
      .db-sel,
      .db-sel-all {
        width: 15px;
        height: 15px;
        cursor: pointer;
        accent-color: var(--ps-accent, #00e5ff);
      }
      .db-sel:focus-visible,
      .db-sel-all:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-bulk-bar {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 0.5rem;
        padding: 0.4rem 0.6rem;
        border-radius: 8px;
        background: color-mix(in oklch, #ff6b6b 8%, rgba(0, 0, 0, 0.25));
        border: 1px solid color-mix(in oklch, #ff6b6b 24%, transparent);
      }
      .db-bulk-count {
        font-size: 0.76rem;
        font-variant-numeric: tabular-nums;
        color: var(--ps-ink, #f4f4ff);
      }
      .db-bulk-delete {
        font: inherit;
        font-size: 0.74rem;
        font-weight: 600;
        padding: 0.28rem 0.7rem;
        border-radius: 6px;
        color: #ff8f9a;
        background: color-mix(in oklch, #ff6b6b 14%, transparent);
        border: 1px solid color-mix(in oklch, #ff6b6b 38%, transparent);
        cursor: pointer;
      }
      .db-bulk-delete:hover:not(:disabled) {
        background: color-mix(in oklch, #ff6b6b 26%, transparent);
        color: #fff;
      }
      .db-bulk-delete:focus-visible {
        outline: 2px solid #ff6b6b;
        outline-offset: 2px;
      }
      .db-bulk-delete:disabled {
        opacity: 0.6;
        cursor: progress;
      }
      .db-bulk-clear {
        font: inherit;
        font-size: 0.72rem;
        padding: 0.28rem 0.55rem;
        border-radius: 6px;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        background: transparent;
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.14));
        cursor: pointer;
      }
      .db-bulk-clear:hover:not(:disabled) {
        color: var(--ps-ink, #f4f4ff);
        background: rgba(255, 255, 255, 0.05);
      }
      .db-bulk-clear:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-edit {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-bottom: 0.5rem;
      }
      .db-edit-field {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
      }
      .db-edit-label {
        font-size: 0.7rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        text-transform: capitalize;
      }
      .db-edit-select {
        font: inherit;
        font-size: 0.74rem;
        padding: 0.2rem 0.4rem;
        border-radius: 6px;
        color: var(--ps-ink, #f4f4ff);
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.14));
      }
      .db-edit-select:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-edit-textarea {
        font: inherit;
        font-size: 0.74rem;
        padding: 0.25rem 0.4rem;
        border-radius: 6px;
        color: var(--ps-ink, #f4f4ff);
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.14));
        resize: vertical;
        min-width: 15rem;
        max-width: 100%;
        line-height: 1.4;
      }
      .db-edit-textarea:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-edit-save {
        font: inherit;
        font-size: 0.7rem;
        padding: 0.2rem 0.5rem;
        border-radius: 6px;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
        cursor: pointer;
      }
      .db-edit-save:hover:not(:disabled) {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
      }
      .db-edit-save:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-edit-save:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .db-export-note {
        margin: 0.4rem 0 0;
        font-size: 0.72rem;
        color: #ffc800;
      }
      .db-readonly-pill {
        margin-left: 0.5rem;
        font-size: 0.62rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        cursor: help;
        white-space: nowrap;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.12));
      }
      .db-scroll {
        overflow-x: auto;
        max-width: 100%;
        border-radius: 8px;
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
      }
      .db-scroll:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .db-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .db-table th,
      .db-table td {
        text-align: left;
        padding: 0.45rem 0.7rem;
        border-bottom: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
        white-space: nowrap;
        vertical-align: top;
      }
      .db-table thead th {
        position: sticky;
        top: 0;
        background: color-mix(in oklch, var(--ps-bg, #060610) 92%, transparent);
        backdrop-filter: blur(4px);
      }
      .db-sort {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.68rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        background: transparent;
        border: none;
        padding: 0;
      }
      .db-sort:hover {
        color: var(--ps-accent, #00e5ff);
      }
      .db-sort:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
        border-radius: 3px;
      }
      .db-arrow {
        color: var(--ps-accent, #00e5ff);
      }
      .db-detail-h {
        width: 2.2rem;
      }
      .db-detail-c {
        text-align: center;
      }
      .db-null {
        font-size: 0.66rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        padding: 0.05rem 0.35rem;
        border-radius: 4px;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
      }
      .db-expand {
        cursor: pointer;
        font: inherit;
        background: transparent;
        border: none;
        color: var(--ps-accent, #00e5ff);
        padding: 0 0.2rem;
        line-height: 1;
      }
      .db-expand:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
        border-radius: 3px;
      }
      tr.is-expanded {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 6%, transparent);
      }
      .db-detail-row td {
        background: rgba(0, 0, 0, 0.28);
      }
      .db-json {
        margin: 0;
        padding: 0.6rem 0.75rem;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.76rem;
        white-space: pre-wrap;
        word-break: break-word;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent);
      }
      .block {
        display: block;
      }
      .mb-3 {
        margin-bottom: 0.75rem;
      }
    `,
  ],
})
export class SiteDataBrowserComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** The site whose data to browse. Bound by the parent site-detail tab. */
  readonly siteId = input<string>('');

  // ── Table picker ─────────────────────────────────────────────────────
  readonly tables = signal<DataOverviewTable[]>([]);
  readonly tablesLoading = signal(false);
  readonly tablesError = signal<string | null>(null);
  readonly selected = signal<DataOverviewTable | null>(null);

  /** At-a-glance Overview: table count + total records + the largest table, derived
   *  from the already-fetched per-table row counts (no extra request). Null until
   *  tables load, so the strip never shows a misleading "0 records" while loading. */
  readonly dataSummary = computed<{
    tableCount: number;
    totalRows: number;
    largest: DataOverviewTable | null;
  } | null>(() => {
    const ts = this.tables();
    if (ts.length === 0) return null;
    const totalRows = ts.reduce((sum, t) => sum + (t.row_count || 0), 0);
    const largest = ts.reduce((max, t) => (t.row_count > (max?.row_count ?? -1) ? t : max), ts[0]);
    return { tableCount: ts.length, totalRows, largest };
  });

  // ── Current page ─────────────────────────────────────────────────────
  readonly columns = signal<string[]>([]);
  /** Columns the owner has hidden from the grid (per-table, persisted). The row
   *  detail + CSV/JSON exports still include EVERY column, so hiding is a view-only
   *  scan aid that never loses or omits data. */
  readonly hiddenColumns = signal<ReadonlySet<string>>(new Set());
  /** Columns actually rendered in the grid = all columns minus the hidden set. */
  readonly visibleColumns = computed(() =>
    this.columns().filter((c) => !this.hiddenColumns().has(c)),
  );
  readonly rows = signal<Array<Record<string, unknown>>>([]);
  readonly total = signal(0);
  readonly limit = signal(25);
  readonly offset = signal(0);
  readonly orderBy = signal<string | null>(null);
  readonly dir = signal<'asc' | 'desc'>('desc');
  /** Server-side text search across the table's non-timestamp safe columns. */
  readonly search = signal('');
  /** Precise per-column exact-match filter (column + value); server re-validates the
   *  column against the safe allowlist. Active only when BOTH are set. Cleared on switch. */
  readonly filterCol = signal('');
  readonly filterVal = signal('');
  readonly rowsLoading = signal(false);
  readonly rowsError = signal<string | null>(null);
  /** Index of the row whose full-JSON detail is expanded (single-open). */
  readonly expandedRow = signal<number | null>(null);
  /** `id` of the row currently being deleted (disables its button + shows "Deleting…"). */
  readonly deletingId = signal<string | null>(null);
  /** Row `id`s checked for a bulk action (deletable tables only). Cleared on any
   *  page/table/filter/sort change (via loadPage) so a stale id can never be deleted. */
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  /** True while a bulk delete is in flight (disables the bulk bar). */
  readonly bulkDeleting = signal(false);
  /** Pending per-column edits for the expanded row (column → draft value); cleared on
   *  row collapse/switch and on a successful save. */
  readonly editDraft = signal<Record<string, string>>({});
  /** True while a column edit is in flight (disables the Save button). */
  readonly savingEdit = signal(false);
  /** The grid cell open for INLINE editing (row+column-keyed — distinct from the column-keyed
   *  `editDraft` the detail panel uses, so double-clicking a cell edits THAT row, not the
   *  expanded one): which row index + column, and its pending value. null = no inline edit. */
  readonly cellEdit = signal<{ rowIndex: number; column: string; value: string } | null>(null);
  /** Re-entrancy guard so an inline commit's own focus-loss (blur firing while the confirm
   *  dialog is open) can't launch a second confirm/PATCH for the same cell. */
  private cellCommitting = false;
  /** Recent data-management mutations (deletes/edits) the owner made here, newest first. */
  readonly activity = signal<DataActivityEvent[]>([]);
  /** The selected table's owner-editable columns as a render-ready list ([] = read-only).
   *  Flattens the enum/text union: `options` is [] for a text column, `maxLength` 0 for an enum. */
  readonly editableColumnsList = computed<
    { column: string; type: string; options: string[]; maxLength: number }[]
  >(() => {
    const ec = this.selected()?.editableColumns ?? {};
    return Object.entries(ec).map(([column, spec]) => ({
      column,
      type: spec.type,
      options: 'options' in spec ? spec.options : [],
      maxLength: 'maxLength' in spec ? spec.maxLength : 0,
    }));
  });

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
    if (id) {
      this.loadTables(id);
      this.loadActivity(id);
    }
  }

  /** Load the recent data-mutation activity (deletes/edits) for this site. Fail-soft:
   *  a failed load leaves the list empty (the panel shows its own empty state). */
  loadActivity(id: string): void {
    if (!id) return;
    this.api
      .getDataActivity(id)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.activity.set(Array.isArray(res?.data?.events) ? res!.data.events : []);
      });
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
    this.filterCol.set('');
    this.filterVal.set('');
    this.expandedRow.set(null);
    this.editDraft.set({}); // a draft belongs to one table's expanded row — never carry it across
    this.rowsError.set(null);
    this.loadPage();
  }

  /** Apply a per-column exact-match filter (column + value), reset to page 1, reload.
   *  Empty column or value clears the filter. The server re-validates the column. */
  applyColumnFilter(col: string, val: string): void {
    this.filterCol.set(col);
    this.filterVal.set(val.trim());
    this.offset.set(0);
    this.loadPage();
  }

  /** Clear the active per-column filter and reload the unfiltered first page. */
  clearColumnFilter(): void {
    if (!this.filterCol() && !this.filterVal()) return;
    this.filterCol.set('');
    this.filterVal.set('');
    this.offset.set(0);
    this.loadPage();
  }

  /** React to the filter-column dropdown: clear when blanked, re-apply when a value
   *  is already typed, else just remember the column (value entry applies it). */
  onFilterColChange(col: string, val: string): void {
    if (!col) {
      this.clearColumnFilter();
      return;
    }
    if (val.trim()) this.applyColumnFilter(col, val);
    else this.filterCol.set(col);
  }

  /** Load the current window of the selected table. Public for Retry + refresh. */
  loadPage(): void {
    const sel = this.selected();
    const id = this.siteId();
    if (!sel || !id) return;
    this.rowsLoading.set(true);
    this.rowsError.set(null);
    this.expandedRow.set(null);
    this.clearSelection(); // a stale id from another page/filter must never be bulk-deleted
    this.api
      .browseDataTable(id, sel.key, {
        limit: this.limit(),
        offset: this.offset(),
        orderBy: this.orderBy() ?? undefined,
        dir: this.dir(),
        search: this.search() || undefined,
        filterCol: this.filterCol() || undefined,
        filterVal: this.filterVal() || undefined,
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
      const cols = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
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

  /** Whether an owner filter (text search OR a per-column filter) is currently active. */
  readonly filterActive = computed(
    () => !!this.search() || (!!this.filterCol() && !!this.filterVal()),
  );

  /**
   * Fetch up to {@link EXPORT_CAP} rows of the selected table across pages,
   * respecting the current sort AND the active search + per-column filter — so an
   * export is the WHOLE MATCHING set (not just the visible page, nor the whole table
   * when a filter is on), still bounded (never loads an unbounded table into the
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
            // Export the FILTERED view — same search + per-column filter as the grid,
            // so the file matches what the owner sees (and `total` is the filtered count).
            search: this.search() || undefined,
            filterCol: this.filterCol() || undefined,
            filterVal: this.filterVal() || undefined,
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
        ? `Exported the first ${cap.toLocaleString()} of ${total.toLocaleString()} ${this.filterActive() ? 'matching ' : ''}rows (export is capped).`
        : null,
    );
    return out.slice(0, cap);
  }

  /** `{site}-{table}[-filtered]-{rowCount}rows` — names the row count + whether the
   *  file is the filtered view (so a filtered export is never mistaken for the full table). */
  private exportBaseName(count: number): string {
    const table = this.selected()?.key ?? 'data';
    const suffix = this.filterActive() ? '-filtered' : '';
    return `${this.siteId() || 'site'}-${table}${suffix}-${count}rows`;
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
    this.editDraft.set({}); // a draft belongs to one expanded row — never bleed across rows
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

  /** `Date.now()`, isolated so tests can pin "now" for deterministic relative-time. */
  protected now(): number {
    return Date.now();
  }

  /**
   * Parse a server timestamp to epoch ms as UTC. D1 stores `datetime('now')` as
   * `YYYY-MM-DD HH:MM:SS` with NO zone — JS would parse that as LOCAL time (wrong by
   * the tz offset), so we normalize to `…THH:MM:SSZ` first. Already-zoned ISO passes
   * through. Returns NaN for an unparseable value.
   */
  private parseUtc(ts: string): number {
    let s = ts.trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
    return Date.parse(s);
  }

  /**
   * Compact relative age of a timestamp: "just now" / "5m" / "3h" / "2d" / "3w" /
   * "5mo" / "1y". Empty string for null/undefined/unparseable (so the template's
   * `@if` hides the chip) — never a fabricated "0" or a wrong local-time delta.
   */
  compactAge(ts: string | null | undefined): string {
    if (!ts) return '';
    const ms = this.parseUtc(ts);
    if (Number.isNaN(ms)) return '';
    const sec = Math.max(0, (this.now() - ms) / 1000);
    if (sec < 60) return 'just now';
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    const w = Math.floor(d / 7);
    if (w < 5) return `${w}w`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo`;
    return `${Math.floor(d / 365)}y`;
  }

  /** Full, correct local-time rendering of a UTC server timestamp (chip tooltip). */
  fullTimestamp(ts: string | null | undefined): string {
    if (!ts) return '';
    const ms = this.parseUtc(ts);
    return Number.isNaN(ms) ? '' : new Date(ms).toLocaleString();
  }

  /** Pretty-print the whole row for the expandable detail panel. */
  rowJson(row: Record<string, unknown>): string {
    try {
      return JSON.stringify(row, null, 2);
    } catch {
      return String(row);
    }
  }

  /** Transient "Copied …" label driving the polite aria-live flash (null = hidden). */
  readonly copied = signal<string | null>(null);
  /** Monotonic token so a newer copy supersedes an older flash without clearTimeout. */
  private copyFlashToken = 0;

  /** Copy a single cell value to the clipboard — raw string, JSON for objects. */
  async copyValue(value: unknown): Promise<void> {
    const text =
      value === null || value === undefined
        ? ''
        : typeof value === 'string'
          ? value
          : typeof value === 'object'
            ? this.formatCell(value)
            : String(value);
    await this.writeClipboard(text);
    this.flashCopied(text.length > 32 ? `${text.slice(0, 32)}…` : text || '(empty)');
  }

  /** Copy the whole row as pretty JSON (the detail view's "Copy JSON" action). */
  async copyRow(row: Record<string, unknown>): Promise<void> {
    await this.writeClipboard(this.rowJson(row));
    this.flashCopied('row JSON');
  }

  /** Template guard: is a row's `id` a usable string delete-key? (`typeof` isn't
   *  callable in a template, and a row without a stable id must stay read-only.) */
  isString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
  }

  /** The current page's selectable row ids (those with a stable string `id`). */
  private selectablePageIds(): string[] {
    return this.rows()
      .map((r) => r['id'])
      .filter((v): v is string => this.isString(v));
  }

  /** Number of rows checked for a bulk action (drives the bulk bar + confirm copy). */
  readonly selectedCount = computed(() => this.selectedIds().size);

  /** True when EVERY selectable row on the page is checked (drives the header checkbox). */
  readonly allPageSelected = computed(() => {
    const ids = this.selectablePageIds();
    const sel = this.selectedIds();
    return ids.length > 0 && ids.every((id) => sel.has(id));
  });

  /** Whether a specific row is checked (its `id` is in the selection set). */
  isRowSelected(row: Record<string, unknown>): boolean {
    const id = row['id'];
    return this.isString(id) && this.selectedIds().has(id);
  }

  /** Toggle one row's checkbox. */
  toggleRowSelected(row: Record<string, unknown>): void {
    const id = row['id'];
    if (!this.isString(id)) return;
    this.selectedIds.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select (or clear) every selectable row on the current page. */
  toggleSelectAllPage(): void {
    const ids = this.selectablePageIds();
    this.selectedIds.update((s) => {
      const allSelected = ids.length > 0 && ids.every((id) => s.has(id));
      const next = new Set(s);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  /** Drop all checked rows (the bulk bar's Clear, and after any re-fetch). */
  clearSelection(): void {
    if (this.selectedIds().size) this.selectedIds.set(new Set());
  }

  /**
   * Permanently delete every SELECTED row of a DELETABLE table in one batch, after an
   * explicit confirmation showing the count + the exact parameterized statement. The
   * server re-checks the allowlist + tenant ownership, caps the batch (≤100), and
   * double-scopes by site, so this can only remove the owner's own rows. Reports honest
   * partial results (deleted vs already-gone) and refreshes the page + counts + activity.
   */
  async bulkDelete(): Promise<void> {
    const sel = this.selected();
    const id = this.siteId();
    const ids = [...this.selectedIds()];
    if (!sel?.deletable || !id || ids.length === 0) return;

    const n = ids.length;
    const noun = n === 1 ? 'row' : 'rows';
    const ok = await this.confirm.confirm({
      title: `Delete ${n} ${noun}?`,
      message:
        `This permanently deletes ${n} selected ${noun} from “${sel.label}” for your site and cannot be undone.\n\n` +
        `Runs: DELETE FROM ${sel.key} WHERE id IN (…) AND site_id = ?  (${n} ${noun})`,
      confirmLabel: `Delete ${n} permanently`,
      danger: true,
    });
    if (!ok) return;

    this.bulkDeleting.set(true);
    this.api
      .bulkDeleteOverviewRows(id, sel.key, ids)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.bulkDeleting.set(false);
        if (!res) {
          this.toast.error('Could not delete the selected rows — please retry.');
          return;
        }
        const { deleted, skipped } = res.data;
        this.toast.success(
          skipped > 0
            ? `Deleted ${deleted} of ${deleted + skipped} — ${skipped} ${skipped === 1 ? 'was' : 'were'} already gone.`
            : `Deleted ${deleted} ${deleted === 1 ? 'row' : 'rows'}.`,
        );
        this.expandedRow.set(null);
        this.loadPage(); // re-fetch the current window (also clears the selection)
        this.loadTables(id); // refresh the Overview row-counts
        this.loadActivity(id); // surface the bulk delete in "Recent activity"
      });
  }

  /**
   * Permanently delete one row of a DELETABLE table (currently Form Submissions),
   * with an explicit confirmation showing the exact parameterized statement. The row
   * MUST carry a stable string `id`; without one it's read-only (no button rendered).
   * The server re-checks the allowlist + tenant ownership + double-scopes by site, so
   * this can only ever remove the owner's own row. Refreshes the page + table counts.
   */
  async deleteRow(row: Record<string, unknown>): Promise<void> {
    const sel = this.selected();
    const id = this.siteId();
    const rowId = row['id'];
    if (!sel?.deletable || !id || !this.isString(rowId)) return;

    const singular = (sel.label || sel.key || 'row').replace(/s$/i, '').toLowerCase();
    const ok = await this.confirm.confirm({
      title: `Delete this ${singular}?`,
      message:
        `This permanently deletes the row from “${sel.label}” for your site and cannot be undone.\n\n` +
        `Runs: DELETE FROM ${sel.key} WHERE id = ? AND site_id = ?  (1 row)`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;

    this.deletingId.set(rowId);
    this.api
      .deleteOverviewRow(id, sel.key, rowId)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.deletingId.set(null);
        if (!res) {
          this.toast.error('Could not delete the row — please retry.');
          return;
        }
        this.toast.success('Row deleted.');
        this.expandedRow.set(null);
        this.loadPage(); // re-fetch the current window + total
        this.loadTables(id); // refresh the table row-counts (Overview strip)
        this.loadActivity(id); // surface the delete in "Recent activity"
      });
  }

  /** The value to show for an editable column: the pending draft if edited, else the row's. */
  draftValue(row: Record<string, unknown>, column: string): string {
    const d = this.editDraft();
    return column in d ? d[column] : String(row[column] ?? '');
  }

  /** Record a pending edit for a column (the Save button enables when it differs). */
  setDraft(column: string, value: unknown): void {
    this.editDraft.update((d) => ({ ...d, [column]: String(value ?? '') }));
  }

  /** True when the column's draft differs from the row's stored value (Save-enabled). */
  isEdited(row: Record<string, unknown>, column: string): boolean {
    const d = this.editDraft();
    return column in d && d[column] !== String(row[column] ?? '');
  }

  /**
   * The SINGLE authoritative save path for a one-column row update, shared by the detail-panel
   * editor ({@link saveEdit}) and the inline grid-cell editor ({@link commitCellEdit}): confirm
   * (showing the exact parameterized UPDATE) → PATCH (the server re-checks the allowlist + typed
   * validation + double-scopes `WHERE id = ? AND site_id = ?`) → toast + refresh grid & activity.
   * Returns the outcome so each caller manages its own draft/inline state; there is one
   * confirmation UX and one audited mutation regardless of entry point.
   */
  private async performRowUpdate(
    sel: DataOverviewTable,
    id: string,
    rowId: string,
    column: string,
    newValue: string,
  ): Promise<'saved' | 'cancelled' | 'failed'> {
    const ok = await this.confirm.confirm({
      title: `Update ${column}?`,
      message:
        `Set “${column}” to “${newValue}” for this row.\n\n` +
        `Runs: UPDATE ${sel.key} SET ${column} = ? WHERE id = ? AND site_id = ?  (1 row)`,
      confirmLabel: 'Save change',
    });
    if (!ok) return 'cancelled';

    this.savingEdit.set(true);
    return new Promise<'saved' | 'failed'>((resolve) => {
      this.api
        .updateOverviewRow(id, sel.key, rowId, column, newValue)
        .pipe(
          catchError(() => of(null)),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe((res) => {
          this.savingEdit.set(false);
          if (!res) {
            this.toast.error(`Could not save ${column} — please retry.`);
            resolve('failed');
            return;
          }
          this.toast.success(`Updated ${column}.`);
          this.loadPage(); // re-fetch so the grid + detail reflect the saved value
          this.loadActivity(id); // surface the edit in "Recent activity"
          resolve('saved');
        });
    });
  }

  /**
   * Save one edited column of a row from the DETAIL PANEL (editable tables only), with a
   * confirmation showing the exact parameterized UPDATE. Reverts the draft on cancel, clears it
   * on save, keeps it on a transient failure so the user can retry.
   */
  async saveEdit(row: Record<string, unknown>, column: string): Promise<void> {
    const sel = this.selected();
    const id = this.siteId();
    const rowId = row['id'];
    const editable = this.editableColumnsList().some((e) => e.column === column);
    if (!sel || !id || !editable || !this.isString(rowId) || !this.isEdited(row, column)) return;
    const newValue = this.editDraft()[column];

    const outcome = await this.performRowUpdate(sel, id, rowId, column, newValue);
    if (outcome === 'cancelled') {
      // Revert the draft so the select snaps back to the stored value.
      this.editDraft.update((d) => {
        const next = { ...d };
        delete next[column];
        return next;
      });
      return;
    }
    if (outcome === 'saved') this.editDraft.set({});
    // 'failed' → leave the draft intact so the user can retry.
  }

  // ── Inline grid-cell editing (double-click / click / Enter a cell → edit in place) ──────
  // The fast path for retriaging a lead's status (or jotting a note) WITHOUT expanding the row.
  // Only owner-editable columns (form_submissions.status/notes) on rows with a stable id become
  // editable cells; every read-only cell keeps its copy affordance. All commits funnel through
  // the same confirmed, audited, double-scoped PATCH as the detail-panel editor.

  /** The edit spec for a column IF it is owner-editable on the selected table, else null. */
  editableSpecFor(
    column: string,
  ): { column: string; type: string; options: string[]; maxLength: number } | null {
    return this.editableColumnsList().find((e) => e.column === column) ?? null;
  }

  /** True when a grid cell is an inline edit-trigger: the column is owner-editable AND the row
   *  carries a stable string `id` to target safely (`WHERE id = ?`). */
  isCellEditable(column: string, row: Record<string, unknown>): boolean {
    return this.isString(row['id']) && this.editableSpecFor(column) !== null;
  }

  /** True when THIS grid cell (row index + column) is the one currently open for inline editing. */
  isEditingCell(rowIndex: number, column: string): boolean {
    const ce = this.cellEdit();
    return ce !== null && ce.rowIndex === rowIndex && ce.column === column;
  }

  /** Open an inline editor on a grid cell, seeded with the row's stored value + focus it (a11y).
   *  No-op for a read-only cell or a row without a stable id. */
  startCellEdit(rowIndex: number, column: string, row: Record<string, unknown>): void {
    if (!this.isCellEditable(column, row)) return;
    this.cellEdit.set({ rowIndex, column, value: String(row[column] ?? '') });
    // Focus the just-rendered editor so keyboard users can act immediately.
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLElement>('.db-cell-editor')?.focus();
    }, 0);
  }

  /** Update the in-flight inline draft value (bound to the inline select/input). */
  setCellDraft(value: unknown): void {
    this.cellEdit.update((ce) => (ce ? { ...ce, value: String(value ?? '') } : ce));
  }

  /** Close the inline editor without saving (Escape / blur-without-change / post-save). */
  cancelCellEdit(): void {
    this.cellEdit.set(null);
  }

  /** Enum inline edit: choosing an option is a deliberate change → set the draft AND commit
   *  (routed through the same confirmed PATCH). */
  onCellSelectChange(row: Record<string, unknown>, value: string): void {
    this.setCellDraft(value);
    void this.commitCellEdit(row);
  }

  /** Close the inline select on blur UNLESS a commit it triggered is still in flight (whose own
   *  focus-loss fired this blur) — the guard keeps the confirmed PATCH from being cancelled. */
  onCellSelectBlur(): void {
    if (!this.cellCommitting) this.cancelCellEdit();
  }

  /**
   * Commit the inline cell edit via the SAME confirmed, audited PATCH path as the detail panel.
   * An unchanged value just closes the editor (no confirm). The re-entrancy guard prevents a
   * blur-after-Enter (or blur-after-select) from launching a second confirm for the same cell.
   * Stays open on a transient failure so the user can retry; closes on save or cancel.
   */
  async commitCellEdit(row: Record<string, unknown>): Promise<void> {
    if (this.cellCommitting) return;
    const ce = this.cellEdit();
    const sel = this.selected();
    const id = this.siteId();
    const rowId = row['id'];
    if (!ce || !sel || !id || !this.isString(rowId)) return;

    const stored = String(row[ce.column] ?? '');
    if (ce.value === stored) {
      this.cancelCellEdit(); // no change → close silently, no confirm/PATCH
      return;
    }

    this.cellCommitting = true;
    try {
      const outcome = await this.performRowUpdate(sel, id, rowId, ce.column, ce.value);
      if (outcome !== 'failed') this.cancelCellEdit();
    } finally {
      this.cellCommitting = false;
    }
  }

  /** Clipboard write, isolated so tests can spy it without a secure-context clipboard. */
  protected writeClipboard(text: string): Promise<void> {
    return navigator.clipboard?.writeText(text) ?? Promise.resolve();
  }

  /** Flash "Copied <label>" for ~1.8s; a token guards against stale timers (a
   *  set-after-destroy is a harmless signal no-op, so no explicit teardown needed). */
  private flashCopied(label: string): void {
    this.copied.set(`Copied ${label}`);
    const token = ++this.copyFlashToken;
    setTimeout(() => {
      if (this.copyFlashToken === token) this.copied.set(null);
    }, 1800);
  }
}
