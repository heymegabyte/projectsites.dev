import { Component, Input, computed, effect, inject, signal, type OnInit, type OnDestroy } from '@angular/core';
import {
  createAngularTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
} from '@tanstack/angular-table';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AdminStateService } from '../admin-state.service';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { ErrorCardComponent } from '../../../components/states';
import { sanitizeAuditSummary } from '../../../utils/sanitize-audit-summary';

/**
 * Shape of an audit row as returned by `GET /api/audit-logs`. The `site`
 * field is populated server-side via a LEFT JOIN against `sites` (or a
 * metadata-JSON fallback) so the `site` column always has data. `message` is
 * a human-readable summary written at the audit-write boundary; nullable here
 * as a belt-and-suspenders for any in-flight rows that lack one.
 */
interface AuditRow {
  id: string;
  action: string;
  message: string | null;
  target_type: string | null;
  target_id: string | null;
  actor_id: string | null;
  metadata: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string;
  site: string | null;
}

/**
 * Escape an arbitrary string into an HTML-safe fragment. Used for every
 * dynamic value rendered via `[innerHTML]` (the JSON syntax highlighter)
 * below — never trust audit data even from our own backend.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Minimal JSON syntax highlighter — strings green, numbers cyan, keys amber,
 * booleans violet, null grey. Mirrors the Traces page (ai-logs.component.ts)
 * so the audit detail panel shares the same colour vocabulary.
 */
function highlightJson(src: string): string {
  return escapeHtml(src).replace(
    /(&quot;(?:\\.|[^"\\])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g,
    (_m, str?: string, colon?: string, bool?: string, num?: string, pun?: string) => {
      if (str) {
        return colon
          ? `<span class="tk-key">${str}</span><span class="tk-pun">${colon}</span>`
          : `<span class="tk-str">${str}</span>`;
      }
      if (bool) return bool === 'null' ? `<span class="tk-null">${bool}</span>` : `<span class="tk-bool">${bool}</span>`;
      if (num) return `<span class="tk-num">${num}</span>`;
      if (pun) return `<span class="tk-pun">${pun}</span>`;
      return _m as string;
    },
  );
}

/** Compact relative-time formatter — "3 min ago", "12 sec ago", "yesterday". */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const delta = Math.max(0, Date.now() - t);
  const s = Math.floor(delta / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/**
 * Fallback statement synthesis for any in-flight row that still lacks a
 * `message` (older writers, replay backfill, etc). Mirrors the worker
 * helper `actionToFallbackMessage` so the UI label matches what would have
 * been persisted had we written the row today.
 */
function actionToFallbackMessage(action: string): string {
  const words = action.split('.').filter(Boolean);
  if (words.length === 0) return action;
  return words
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .replace(/_/g, ' ');
}

/**
 * Admin audit-log surface. Renders the org's `audit_logs` as a native
 * TanStack Table view (perf-wave ag-grid→TanStack migration, 2026-08-20 —
 * removes the critical `aria-required-children` axe violation that was
 * fundamental to ag-grid's `.ag-root[role="grid"]` structure). The
 * backend call is always org-wide; a site `<select>` filters client-side.
 * Auto-polls every 15s, pauses on hidden tab.
 *
 * ## Master/detail
 *
 * Clicking the row kebab flips that row id in `expandedIds`; a real Angular
 * `<tr class="detail-row">` renders directly below the master row (colspan
 * across all five columns) showing actor, target, request_id, and the
 * syntax-highlighted metadata JSON. No synthetic row splicing, no
 * imperative renderers — the detail panel is ordinary template DOM, so it
 * participates in Angular change detection and is natively axe-clean.
 *
 * @example
 * ```html
 * <app-admin-audit />
 * <!-- Renders the auto-polling table + scope chip + per-row detail
 *      panel expansion via the kebab on the right of every row. -->
 * ```
 */
@Component({
  selector: 'app-admin-audit',
  standalone: true,
  imports: [RollingCounterComponent, ErrorCardComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-4">
      <header class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="kicker">Forensics</div>
          <!-- Dual-use: standalone /admin/audit this IS the page h1; embedded as the
               Audit-Trail tab inside /admin/logs (which already renders its own Logs h1)
               demote to h2 so the page keeps EXACTLY one h1 (WCAG 1.3.1 / single-h1). The
               admin/logs 2-h1s prod-e2e failure was this. AL-173. -->
          @if (embedded) {
            <h2 class="section-h text-lg font-bold text-white m-0">Audit Log</h2>
          } @else {
            <h1 class="section-h text-lg font-bold text-white m-0">Audit Log</h1>
          }
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
            Every privileged action — what happened, who did it, when.
            @if (autoRefreshPaused()) { Auto-refresh paused } @else { Auto-refreshing every 15s }
            · last sync {{ lastSyncLabel() }}.
          </p>
        </div>
        <div class="flex gap-2 items-center">
          @if (showScopeChip()) {
            <button
              type="button"
              data-testid="audit-scope-chip"
              class="scope-chip"
              [title]="'Audit events span every site in the ' + scopeName() + ' org — use the Site filter above the table to narrow. × hides this label.'"
              (click)="clearScope()">
              Org: {{ scopeName() }} <span class="x">×</span>
            </button>
          }
          <button class="btn-ghost" (click)="exportCsv()" [disabled]="!canExport()" [attr.aria-disabled]="!canExport()" [attr.title]="canExport() ? 'Download visible audit events as CSV' : 'No audit events to export yet'">Export CSV</button>
        </div>
      </header>

      <div class="grid grid-cols-4 gap-3 text-[0.78rem]">
        @if (loading() && rows().length === 0) {
          <!-- Labels stay mounted; only the numbers shimmer so the cards don't
               reflow (header text + width) when the first fetch resolves —
               mirrors the site-dna stats skeleton (premature-stat-during-load). -->
          @for (label of statLabels; track label) {
            <div class="card" aria-busy="true"><div class="muted-h">{{ label }}</div><div class="skeleton skeleton-line"></div></div>
          }
        } @else if (showStats()) {
          <!-- Hidden when the load errored with no data — definitive "0 events ·
               0 actions · …" over the error card is wrong (unknown, not 0). -->
          <div class="card"><div class="muted-h">Events</div><div class="text-2xl font-bold text-white"><app-rolling-counter [value]="totalCount()" [duration]="1100" /></div></div>
          <div class="card"><div class="muted-h">Unique actions</div><div class="text-2xl font-bold text-white"><app-rolling-counter [value]="uniqueActions()" [duration]="1100" /></div></div>
          <div class="card"><div class="muted-h">Last 24h</div><div class="text-2xl font-bold text-white"><app-rolling-counter [value]="last24h()" [duration]="1100" /></div></div>
          <div class="card"><div class="muted-h">Actors</div><div class="text-2xl font-bold text-white"><app-rolling-counter [value]="uniqueActors()" [duration]="1100" /></div></div>
        }
      </div>

      @if (hasHiddenEvents()) {
        <p class="text-[0.7rem] text-amber-300/90 mt-1" role="status" data-testid="audit-cap-note"
           title="The stat cards count EVERY event (server-side totals); only the table below is capped at the {{ rows().length }} most recent rows. Older rows are still stored.">
          Showing the latest {{ rows().length }} of {{ totalCount() }} events in the table — the stat cards above count all {{ totalCount() }}.
        </p>
      }

      @if (loadError(); as err) {
        <app-error-card data-testid="audit-error" class="block"
          title="Couldn't load audit events"
          [message]="err"
          [correlationId]="loadErrorRef()"
          (retry)="load()" />
      } @else if (!loading() && rows().length === 0) {
        <div class="empty-state card" role="status" data-testid="audit-empty">
          <svg class="empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h12"/>
          </svg>
          <h3 class="empty-title">No audit events yet</h3>
          <p class="empty-body">Privileged actions you take — deploys, hostname changes, billing edits — will appear here within seconds.</p>
          <button class="btn-gradient" type="button" (click)="load()">Refresh now</button>
        </div>
      }

      <!-- Table renders ONLY with rows — when empty (or errored) the card above is
           the sole empty state, never a redundant "no rows" area beneath it. -->
      @if (rows().length > 0) {
      <div class="grid-frame">
        <div class="grid-toolbar">
          <label class="site-filter" for="audit-site-filter">
            <span class="muted-h">Site</span>
            <select id="audit-site-filter" class="site-select" aria-label="Filter audit events by site"
                    [value]="activeSiteFilter()" (change)="onSiteFilter($event)">
              <option value="">All sites</option>
              @for (s of filteredSites(); track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
          </label>
          <span class="page-count" role="status" data-testid="audit-page-count">
            Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredCount() }}
          </span>
        </div>

        <table class="ps-audit-grid" data-testid="audit-grid">
          <colgroup>
            <col class="col-action" />
            <col class="col-message" />
            <col class="col-when" />
            <col class="col-site" />
            <col class="col-expand" />
          </colgroup>
          <thead>
            <tr>
              @for (header of table.getHeaderGroups()[0].headers; track header.id) {
                @if (header.column.getCanSort()) {
                  <th
                    scope="col"
                    class="th-sortable"
                    tabindex="0"
                    [attr.aria-sort]="ariaSort(header.column.getIsSorted())"
                    (click)="header.column.toggleSorting()"
                    (keydown.enter)="header.column.toggleSorting()"
                    (keydown.space)="header.column.toggleSorting(); $event.preventDefault()">
                    {{ headerLabel[header.id] }}
                    <span class="sort-glyph" aria-hidden="true">{{ sortGlyph(header.column.getIsSorted()) }}</span>
                  </th>
                } @else {
                  <th scope="col" class="th-expand">{{ headerLabel[header.id] }}</th>
                }
              }
            </tr>
          </thead>
          <tbody>
            @for (row of table.getRowModel().rows; track row.original.id) {
              <tr class="master-row" [class.is-expanded]="expandedIds().has(row.original.id)">
                <td class="cell-action">
                  <span class="cell-action-pill" [title]="row.original.action">{{ row.original.action }}</span>
                </td>
                <td class="cell-message-td">
                  <span
                    class="cell-message"
                    [class.is-fallback]="row.original.message == null"
                    [title]="sanitize(row.original.message ?? fallbackMsg(row.original.action))">
                    {{ sanitize(row.original.message ?? fallbackMsg(row.original.action)) }}
                  </span>
                </td>
                <td class="cell-when" [title]="isoOf(row.original.created_at)">{{ relTime(row.original.created_at) }}</td>
                <td class="cell-site">{{ row.original.site ?? '—' }}</td>
                <td class="cell-expand">
                  <button
                    type="button"
                    class="kebab-btn"
                    [class.is-open]="expandedIds().has(row.original.id)"
                    [attr.aria-expanded]="expandedIds().has(row.original.id)"
                    [attr.aria-label]="expandedIds().has(row.original.id) ? 'Collapse audit detail' : 'Expand audit detail'"
                    [attr.data-testid]="'audit-row-expand-' + row.original.id"
                    (click)="toggleExpand(row.original)">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                      <circle cx="8" cy="3" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/>
                    </svg>
                  </button>
                </td>
              </tr>
              @if (expandedIds().has(row.original.id)) {
                <tr class="detail-row" [attr.data-testid]="'audit-detail-' + row.original.id">
                  <td [attr.colspan]="columnCount">
                    <div class="detail-card">
                      <div class="detail-head">
                        <h4>Event detail</h4>
                        <button
                          type="button"
                          class="det-action"
                          [attr.data-testid]="'audit-copy-row-' + row.original.id"
                          (click)="copyRowAsJson(row.original)">
                          Copy row JSON
                        </button>
                      </div>
                      <div class="detail-grid-3">
                        <div class="det-block">
                          <div class="det-label">When</div>
                          <div class="det-value">{{ whenLocale(row.original) }}</div>
                          <div class="det-value mono dim-iso">{{ isoOf(row.original.created_at) }}</div>
                        </div>
                        <div class="det-block">
                          <div class="det-label">Actor</div>
                          <div class="det-value mono" [title]="actorTitleOf(row.original)">{{ actorLabel(row.original) }}</div>
                        </div>
                        <div class="det-block">
                          <div class="det-label">Site</div>
                          <div class="det-value mono">{{ row.original.site ?? '—' }}</div>
                        </div>
                      </div>
                      <div class="detail-grid-2">
                        <div class="det-block">
                          <div class="det-label">Action</div>
                          <div class="det-value mono">{{ row.original.action }}</div>
                        </div>
                        <div class="det-block">
                          <div class="det-label">Target</div>
                          <div class="det-value mono" [title]="targetLabel(row.original)">{{ targetLabel(row.original) }}</div>
                        </div>
                      </div>
                      <div class="req-row">
                        <span class="req-label">Request ID</span>
                        <code>{{ row.original.request_id || '—' }}</code>
                        @if (row.original.request_id) {
                          <button
                            type="button"
                            class="det-action"
                            [attr.data-testid]="'audit-copy-correlation-' + row.original.id"
                            (click)="copyCorrelationId(row.original.request_id)">
                            Copy
                          </button>
                        }
                      </div>
                      <div class="det-block">
                        <div class="det-label">Metadata</div>
                        @if (metaOf(row.original); as meta) {
                          <pre [innerHTML]="highlightJson(meta)"></pre>
                        } @else {
                          <div class="det-value dim-italic">No metadata recorded for this event.</div>
                        }
                      </div>
                    </div>
                  </td>
                </tr>
              }
            } @empty {
              <tr class="filtered-empty-row">
                <td [attr.colspan]="columnCount">
                  <div class="filtered-empty" role="status">No events match this site filter.</div>
                </td>
              </tr>
            }
          </tbody>
        </table>

        <div class="grid-footer">
          <label for="audit-page-size" class="page-size-label">
            <select id="audit-page-size" class="site-select" aria-label="Rows per page" (change)="onPageSize($event)">
              @for (n of pageSizeOptions; track n) {
                <option [value]="n" [selected]="n === pagination().pageSize">{{ n }}</option>
              }
            </select>
          </label>
          <span class="page-indicator">Page {{ table.getState().pagination.pageIndex + 1 }} of {{ table.getPageCount() }}</span>
          <div class="pager-btns">
            <button type="button" class="btn-mini" [disabled]="!table.getCanPreviousPage()" (click)="table.previousPage()" aria-label="Previous page">‹ Prev</button>
            <button type="button" class="btn-mini" [disabled]="!table.getCanNextPage()" (click)="table.nextPage()" aria-label="Next page">Next ›</button>
          </div>
        </div>
      </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 1.2rem; }
    .section-h { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    .btn-ghost { padding: 0.5rem 1rem; border-radius: 8px; background: transparent; color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); cursor: pointer; font-size: 0.74rem; }
    .btn-mini { padding: 0.2rem 0.55rem; border-radius: 6px; background: rgba(0,229,255,0.12); border: 1px solid rgba(0,229,255,0.30); color: #00E5FF; font-size: 0.62rem; font-weight: 700; cursor: pointer; letter-spacing: 0.04em; text-transform: uppercase; transition: background 140ms ease; }
    .btn-mini:hover:not(:disabled) { background: rgba(0,229,255,0.22); }
    .btn-mini:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-gradient { padding: 0.5rem 1rem; border-radius: 10px; background: var(--ps-grad-primary); color: #060610; font-size: 0.74rem; font-weight: 700; border: 0; cursor: pointer; box-shadow: 0 6px 18px -8px rgba(0, 212, 255, 0.55); transition: transform 140ms ease, box-shadow 140ms ease; }
    .btn-gradient:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(0, 212, 255, 0.7); }
    .scope-chip { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.85rem; border-radius: 999px; background: rgba(0,229,255,0.10); color: #00E5FF; border: 1px solid rgba(0,229,255,0.35); cursor: pointer; font-size: 0.74rem; font-weight: 600; }
    .scope-chip:hover { background: rgba(0,229,255,0.18); }
    .scope-chip .x { font-size: 0.95rem; line-height: 1; opacity: 0.85; }
    .scope-chip-all { background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.75); border-color: rgba(255,255,255,0.10); cursor: default; }
    .muted-h { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); font-weight: 700; margin-bottom: 0.3rem; }
    .grid-frame {
      width: 100%;
      border: 1px solid color-mix(in oklch, currentColor 12%, transparent);
      border-radius: var(--ps-radius-lg, 14px);
      overflow: hidden;
      background: rgba(0,0,0,0.18);
      box-shadow: var(--ps-shadow-md, 0 4px 12px rgba(0,0,0,0.18));
    }
    .skeleton { background: rgba(255,255,255,0.10); border-radius: 8px; animation: skel-pulse 1.4s ease-in-out infinite; }
    .skeleton-line { height: 28px; margin-top: 0.45rem; }
    @keyframes skel-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; opacity: 0.7; } }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2.5rem 1.2rem; gap: 0.6rem; }
    .empty-icon { color: rgba(0, 229, 255, 0.65); }
    .error-state { border-color: rgba(255, 92, 122, 0.32); }
    .error-icon { color: rgba(255, 92, 122, 0.8); }
    .empty-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; margin: 0.2rem 0 0; }
    .empty-body { font-size: 0.78rem; color: rgba(255,255,255,0.6); margin: 0 0 0.5rem; max-width: 360px; }

    /* ─── Toolbar (site filter + page count) ─────────────────────────── */
    .grid-toolbar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .site-filter { display: inline-flex; align-items: center; gap: 8px; }
    .site-filter .muted-h { margin-bottom: 0; }
    .site-select {
      background: #0d0d1f; color: #e5e7eb;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      padding: 6px 10px; font-size: 0.72rem; font-family: inherit; cursor: pointer;
    }
    .site-select:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    .page-count { font-size: 0.7rem; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; }

    /* ─── Native table (TanStack headless) ───────────────────────────── */
    table.ps-audit-grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.76rem; }
    .ps-audit-grid col.col-action { width: 220px; }
    .ps-audit-grid col.col-when { width: 140px; }
    .ps-audit-grid col.col-site { width: 140px; }
    .ps-audit-grid col.col-expand { width: 50px; }
    .ps-audit-grid thead th {
      position: sticky; top: 0; z-index: 1;
      background: #0e0e22; text-align: left; padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: rgba(255,255,255,0.6); font-weight: 700;
    }
    .ps-audit-grid th.th-sortable { cursor: pointer; user-select: none; transition: color 140ms ease; }
    .ps-audit-grid th.th-sortable:hover { color: #00E5FF; }
    .ps-audit-grid th.th-sortable:focus-visible { outline: 2px solid #00E5FF; outline-offset: -2px; }
    .ps-audit-grid th.th-expand { width: 50px; }
    .sort-glyph { color: #00E5FF; }
    .ps-audit-grid td {
      padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.04);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
    }
    .master-row { transition: background 140ms ease; }
    .master-row:hover { background: rgba(0,229,255,0.06); box-shadow: inset 3px 0 0 rgba(0,229,255,0.35); }
    .master-row.is-expanded { background: rgba(0,229,255,0.03); }

    /* ─── Cell: action code pill (JetBrains Mono) ────────────────────── */
    .cell-action-pill {
      display: inline-block; max-width: 100%; vertical-align: middle;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 2px 9px; border-radius: 999px;
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem; font-weight: 600; letter-spacing: 0.01em;
      background: rgba(0,229,255,0.10); color: #00E5FF;
      border: 1px solid rgba(0,229,255,0.22);
    }

    /* ─── Cell: log statement (primary content) ──────────────────────── */
    .cell-message {
      font-family: 'Sora', system-ui, sans-serif;
      font-weight: 500; font-size: 0.78rem;
      letter-spacing: -0.005em;
      color: rgba(245,245,247,0.96);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cell-message.is-fallback { color: rgba(255,255,255,0.55); font-style: italic; }
    .cell-when { color: rgba(255,255,255,0.72); font-variant-numeric: tabular-nums; }
    .cell-site { color: rgba(255,255,255,0.65); }

    /* ─── Cell: expand-kebab (rotates on open) ───────────────────────── */
    .kebab-btn {
      width: 26px; height: 26px; border-radius: 6px; border: 1px solid transparent;
      background: transparent; color: rgba(255,255,255,0.55); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 200ms ease;
    }
    .kebab-btn:hover { background: rgba(0,229,255,0.12); color: #00E5FF; border-color: rgba(0,229,255,0.30); }
    .kebab-btn.is-open { background: rgba(0,229,255,0.18); color: #00E5FF; border-color: rgba(0,229,255,0.45); transform: rotate(90deg); }
    .kebab-btn:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .kebab-btn { transition: none; } }

    /* ─── Detail panel: master/detail expansion ──────────────────────── */
    .detail-row td { padding: 0; border-bottom: 1px solid rgba(0,229,255,0.10); white-space: normal; overflow: visible; }
    .detail-card {
      padding: 1rem 1.2rem 1.2rem; margin: 0;
      background: linear-gradient(180deg, rgba(0,229,255,0.04), rgba(124,58,237,0.02));
      border-radius: var(--ps-radius-lg, 14px);
      animation: detail-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes detail-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { .detail-card { animation: none; } }
    .detail-head { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.7rem; }
    .detail-head h4 {
      font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em;
      font-size: 0.92rem; color: #fff; margin: 0;
    }
    .detail-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.8rem; margin-bottom: 0.7rem; }
    .detail-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.8rem; margin-bottom: 0.7rem; }
    .det-block { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
    .det-label { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.55); font-weight: 700; }
    .det-value {
      font-size: 0.74rem; color: rgba(245,245,247,0.92);
      word-break: break-word; line-height: 1.45;
    }
    .det-value.mono {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem;
    }
    .det-value.dim-iso { opacity: 0.7; font-size: 0.62rem; }
    .det-value.dim-italic { opacity: 0.6; font-style: italic; }
    .req-row {
      display: flex; align-items: center; gap: 0.55rem;
      padding: 0.45rem 0.6rem; border-radius: 8px;
      background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.06);
      margin-bottom: 0.7rem;
    }
    .req-row code {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem; color: rgba(245,245,247,0.92); flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .req-label { font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.55); font-weight: 700; }
    .detail-card pre {
      background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px; padding: 0.7rem 0.9rem;
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem; line-height: 1.55;
      white-space: pre-wrap; word-break: break-word;
      max-height: 200px; overflow: auto; margin: 0;
      color: rgba(245,245,247,0.92);
    }
    .tk-key  { color: #fbbf24; }
    .tk-str  { color: #86efac; }
    .tk-num  { color: #67e8f9; }
    .tk-bool { color: #c4b5fd; }
    .tk-null { color: rgba(255,255,255,0.45); }
    .tk-pun  { color: rgba(255,255,255,0.55); }
    .det-action {
      padding: 0.35rem 0.75rem; border-radius: 8px; font-size: 0.64rem; font-weight: 700;
      letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer;
      border: 1px solid rgba(0,229,255,0.30); background: rgba(0,229,255,0.10); color: #00E5FF;
      transition: background 140ms ease, transform 140ms ease;
    }
    .det-action:hover { background: rgba(0,229,255,0.22); transform: translateY(-1px); }
    .det-action:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .det-action { transition: none; transform: none !important; } }

    /* ─── Footer (pagination) ────────────────────────────────────────── */
    .grid-footer {
      display: flex; align-items: center; justify-content: flex-end; gap: 12px;
      padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.06);
    }
    .page-size-label { display: inline-flex; }
    .page-indicator { font-size: 0.72rem; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
    .pager-btns { display: flex; gap: 6px; }
    .filtered-empty-row td { padding: 0; white-space: normal; }
    .filtered-empty { padding: 28px 14px; text-align: center; font-size: 0.76rem; color: rgba(255,255,255,0.55); }
  `],
})
export class AdminAuditComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  state = inject(AdminStateService);

  /**
   * When true, this component is embedded as the "Audit Trail" tab inside the Logs
   * dashboard (which owns the page's <h1>Logs</h1>), so its own heading renders as an
   * <h2> to keep the page at exactly one h1. Standalone at /admin/audit it stays false
   * → the heading is the page h1. (AL-173 — fixes the /admin/logs double-h1.)
   */
  @Input() embedded = false;

  /** The four KPI stat-card headers — shared by the loading skeleton and the
   *  loaded cards so the muted-h labels never swap from a generic "Loading"
   *  (which reflowed text + card width on resolve). Keep in sync with the
   *  loaded stat-card markup. */
  readonly statLabels = ['Events', 'Unique actions', 'Last 24h', 'Actors'] as const;
  /** Scrub stray interpolated `undefined`/`null` from a stored summary at render
   *  (legacy rows persist — shared with the dashboard widget). AL-139. */
  readonly sanitize = sanitizeAuditSummary;
  rows = signal<AuditRow[]>([]);
  /** Raw `meta.total` from the last load (a worker COUNT(*)); 0 when unknown. */
  private readonly metaTotal = signal(0);
  /** TRUE org-wide (or site-scoped) aggregate stats from the worker (`meta.stats`),
   *  computed over the FULL set — independent of the ≤500-row page. Null for an older
   *  worker → the cards fall back to computing over the loaded rows (which UNDERCOUNTS
   *  once the org logs >500 events, e.g. "Last 24h" showing 500 for 1338 real). */
  private readonly metaStats = signal<{ unique_actions: number; actors: number; last_24h: number } | null>(null);
  /** TRUE org-wide audit-event count from the worker (independent of the ≤500-row
   *  page loaded). Falls back to the loaded length for an older worker w/o meta;
   *  never reports fewer than what's on screen. */
  readonly totalCount = computed(() => Math.max(this.metaTotal(), this.rows().length));
  /** True when the store holds more events than the loaded page — drives the honest
   *  "showing latest N of M" note so the operator knows the table/stats are a capped window. */
  readonly hasHiddenEvents = computed(() => this.totalCount() > this.rows().length);
  loading = signal(false);
  /** Set when /audit-logs fails so we show a distinct error card instead of the
   *  misleading "No audit events yet" empty state (a security log must never
   *  imply zero activity when the fetch actually failed). */
  loadError = signal<string | null>(null);
  /** Consecutive failed auto-polls. After MAX, the 15s poll PAUSES so it stops
   *  re-hammering a persistently-failing endpoint ([[error-recovery]] "retry
   *  with backoff, max 3"). Manual Retry (+ tab-return) bypasses the guard and a
   *  successful load resets the counter → auto-poll resumes. */
  private static readonly MAX_AUTO_RETRIES = 3;
  readonly consecutiveErrors = signal(0);
  readonly autoRefreshPaused = computed(() => this.consecutiveErrors() >= AdminAuditComponent.MAX_AUTO_RETRIES);
  /** Worker request_id from a failed load → the copyable support reference on the error card. */
  readonly loadErrorRef = signal('');

  /** Set of master-row ids currently expanded with their detail panel open. */
  readonly expandedIds = signal<Set<string>>(new Set<string>());

  /** Export CSV is meaningful only when real audit events exist. Disables the
   *  button when empty, matching analytics (`!envelope()`) + forms
   *  (`exportRows().length === 0`) so it never downloads a headers-only CSV /
   *  acts as a dead button. */
  readonly canExport = computed(() => this.rows().length > 0);
  /** Stat cards hidden when the load errored with no data — a definitive
   *  "0 events · 0 actions · …" over the error card is wrong (unknown, not 0). */
  showStats = computed<boolean>(() => !this.loadError() || this.rows().length > 0);
  /**
   * The "Org:" chip is a purely visual scope label — the audit API always loads events
   * across ALL sites in the caller's org; clicking the × clears the label without
   * re-filtering. `scopeSlug` is a stable sentinel that drives the dismiss logic;
   * `scopeName` is the TRUTHFUL org label, derived from the REAL org (name → id →
   * generic). It was hardcoded to the literal `'megabytespace'` — a lie for every org
   * but that one (e.g. "E2E Test Org" saw "Org: megabytespace"). See
   * [[hardcoded-default-drifts-from-enforced-limit]] + [[verify-against-source-of-truth]].
   */
  scopeSlug = signal<string | null>('org');
  readonly scopeName = computed(
    () => this.state.orgName() || this.state.orgId() || 'your organization',
  );

  /**
   * Snapshot of the scope slug at component-mount time. The "Org:" chip is
   * gated on `scopeSlug() === initialScopeSlug` — the moment the user clears
   * or changes the filter, the computed `showScopeChip` flips false and
   * Angular's `@if` removes the chip from the DOM. Signal reactivity is the
   * event — no manual listener wiring needed.
   */
  private readonly initialScopeSlug: string | null = this.scopeSlug();

  /** Drives the `@if` around the scope chip. Computed so it re-evaluates on
   *  EVERY mutation of `scopeSlug()` — chip auto-removes on clear AND on any
   *  divergence from the initial value. */
  readonly showScopeChip = computed(() => {
    const s = this.scopeSlug();
    return s !== null && s === this.initialScopeSlug;
  });
  lastSyncAt = signal<number>(0);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler?: () => void;

  /** Polling cadence in ms — matched to operator expectations for "live". */
  private static readonly POLL_MS = 15_000;

  // ── TanStack headless table (sort + filter + pagination) ──────────────

  /** Human header labels keyed by column id (template reads these). */
  readonly headerLabel: Record<string, string> = {
    action: 'Action',
    message: 'Log statement',
    created_at: 'When',
    site: 'Site',
    expand: '',
  };
  /** Column count for the detail row's colspan + the filtered-empty row. */
  readonly columnCount = 5;
  /** Page-size options — mirrors the old ag-grid selector. */
  readonly pageSizeOptions = [25, 50, 100, 250] as const;
  /** Sortable column ids — the col-state restore validates against this set. */
  private static readonly SORT_IDS = ['action', 'message', 'created_at', 'site'] as const;
  /** localStorage key for the persisted table state (sort) — key reused from
   *  the ag-grid era; the old column-state shape fails validation and is
   *  silently ignored. */
  private static readonly COL_STATE_KEY = 'ps_audit_grid_v2';

  /** Restore a valid sorting state from localStorage; `[]` when absent/corrupt. */
  private static restoreSort(): SortingState {
    try {
      const raw = localStorage.getItem(AdminAuditComponent.COL_STATE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { sorting?: unknown })?.sorting)
          ? ((parsed as { sorting: unknown[] }).sorting as unknown[])
          : null;
      if (!arr) return [];
      const out: SortingState = [];
      for (const item of arr) {
        const s = item as { id?: unknown; desc?: unknown };
        if (
          typeof s?.id === 'string' &&
          (AdminAuditComponent.SORT_IDS as readonly string[]).includes(s.id) &&
          typeof s.desc === 'boolean'
        ) {
          out.push({ id: s.id, desc: s.desc });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Initial sort: restored state when valid, else the canonical `When` desc. */
  private static defaultSort(): SortingState {
    const restored = AdminAuditComponent.restoreSort();
    return restored.length > 0 ? restored : [{ id: 'created_at', desc: true }];
  }

  readonly sorting = signal<SortingState>(AdminAuditComponent.defaultSort());
  /** Client-side column filters — only `site` is ever set (the toolbar select). */
  readonly columnFilters = signal<ColumnFiltersState>([]);
  /** Pagination state — pageSize 50 default (old ag-grid parity). */
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: 50 });

  private readonly columns: ColumnDef<AuditRow>[] = [
    { id: 'action', accessorKey: 'action' },
    { id: 'message', accessorKey: 'message' },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      // ISO-8601 strings sort lexicographically = chronologically, but older
      // rows may carry other formats — Date.parse comparator keeps parity
      // with the old ag-grid date comparator.
      sortingFn: (rowA, rowB) =>
        Date.parse(String(rowA.original.created_at ?? 0)) - Date.parse(String(rowB.original.created_at ?? 0)),
    },
    {
      id: 'site',
      accessorKey: 'site',
      // Exact-match filter (the toolbar select picks ONE slug) — the old
      // ag-grid model used type:'equals' here too. Null sites match '—'.
      filterFn: (row, _columnId, filterValue) => (row.original.site ?? '—') === filterValue,
    },
    { id: 'expand', enableSorting: false },
  ];

  readonly table = createAngularTable<AuditRow>(() => ({
    data: this.rows(),
    columns: this.columns,
    state: {
      sorting: this.sorting(),
      columnFilters: this.columnFilters(),
      pagination: this.pagination(),
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(this.sorting()) : updater;
      this.sorting.set(next);
      this.persistColState();
    },
    onColumnFiltersChange: (updater) =>
      this.columnFilters.set(typeof updater === 'function' ? updater(this.columnFilters()) : updater),
    onPaginationChange: (updater) =>
      this.pagination.set(typeof updater === 'function' ? updater(this.pagination()) : updater),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  /** Distinct non-null site slugs in the loaded page — the filter options. */
  readonly filteredSites = computed<string[]>(() =>
    [...new Set(this.rows().map((r) => r.site).filter((s): s is string => !!s))].sort(),
  );
  /** The currently-selected site slug ('' = all sites). */
  readonly activeSiteFilter = computed<string>(() => {
    const f = this.columnFilters().find((c) => c.id === 'site');
    return typeof f?.value === 'string' ? f.value : '';
  });
  /** Rows surviving the client-side filters (independent of pagination). */
  readonly filteredCount = computed(() => this.table.getFilteredRowModel().rows.length);

  constructor() {
    // Clamp a stale pageIndex after a poll/filter shrinks the row set —
    // TanStack leaves an empty page where ag-grid silently re-rewound.
    // Reads the filtered row model so data + filter changes re-check; the
    // guard converges (setPageIndex only fires while out of range).
    effect(() => {
      if (this.table.getFilteredRowModel().rows.length === 0) return;
      const pageCount = this.table.getPageCount();
      const pageIndex = this.table.getState().pagination.pageIndex;
      if (pageIndex >= pageCount) {
        this.table.setPageIndex(pageCount - 1);
      }
    });
  }

  /** Persist the sort state under `ps_audit_grid_v2` (`{sorting:[…]}` shape). */
  private persistColState(): void {
    try {
      localStorage.setItem(
        AdminAuditComponent.COL_STATE_KEY,
        JSON.stringify({ sorting: this.sorting() }),
      );
    } catch {
      /* ignore — private mode / quota errors must never break the table */
    }
  }

  /** Map TanStack's `false | 'asc' | 'desc'` to an aria-sort token. */
  ariaSort(dir: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
    return dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  }
  /** Sort indicator glyph for the header. */
  sortGlyph(dir: false | 'asc' | 'desc'): string {
    return dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : '↕';
  }

  /** Toolbar site-select handler — set/clear the `site` column filter and rewind to page 1. */
  onSiteFilter(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    this.columnFilters.set(v ? [{ id: 'site', value: v }] : []);
    this.pagination.update((p) => ({ ...p, pageIndex: 0 }));
  }

  /** Page-size selector handler — resets to page 1 on size change. */
  onPageSize(ev: Event): void {
    const n = Number((ev.target as HTMLSelectElement).value);
    if (!(this.pageSizeOptions as readonly number[]).includes(n)) return;
    this.pagination.set({ pageIndex: 0, pageSize: n });
  }

  /** 1-based first visible row number (0 when the filter empties the set). */
  pageStart(): number {
    if (this.filteredCount() === 0) return 0;
    return this.pagination().pageIndex * this.pagination().pageSize + 1;
  }
  /** 1-based last visible row number, clamped to the filtered total. */
  pageEnd(): number {
    return Math.min((this.pagination().pageIndex + 1) * this.pagination().pageSize, this.filteredCount());
  }

  // Prefer the worker's TRUE full-set aggregates (meta.stats); fall back to the loaded
  // rows only for an older worker without meta.stats (undercounts past the 500-row page).
  uniqueActions(): number { return this.metaStats()?.unique_actions ?? new Set(this.rows().map((r) => r.action)).size; }
  uniqueActors(): number { return this.metaStats()?.actors ?? new Set(this.rows().map((r) => r.actor_id).filter(Boolean)).size; }
  last24h(): number {
    const s = this.metaStats();
    if (s) return s.last_24h;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    return this.rows().filter((r) => Date.parse(r.created_at) >= cutoff).length;
  }

  /** Human-readable "last sync 2s ago" label. Recomputes on every Angular
   *  change-detection tick (cheap — just two Date.now() ops).
   *
   * @example "2s ago" → after a fresh poll | "—" before first sync
   */
  lastSyncLabel(): string {
    const t = this.lastSyncAt();
    if (!t) return '—';
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ago`;
  }

  ngOnInit(): void {
    this.load();
    // Poll every 15s, but pause when the tab is hidden so we don't burn API
    // quota on background tabs. Resume + immediate sync on visibility return.
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (this.autoRefreshPaused()) return; // stopped after repeated errors; Retry/tab-return resumes
      this.load();
    }, AdminAuditComponent.POLL_MS);
    this.visibilityHandler = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        this.load();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /**
   * Fetch audit rows across ALL sites in the org. The chip in the toolbar is
   * a visual label only — the backend call never pre-filters by site. The
   * backend caps at 500 rows; the table client-side filters from there.
   */
  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.loadErrorRef.set('');
    const params: Record<string, string> = { limit: '500' };
    this.api
      .get<{
        data: AuditRow[];
        meta?: {
          total?: number;
          has_more?: boolean;
          stats?: { unique_actions: number; actors: number; last_24h: number };
        };
      }>('/audit-logs', params, { silent: true })
      .subscribe({
      next: (r) => {
        this.rows.set(r.data ?? []);
        // TRUE org-wide count so the operator knows when the 500-row window hides
        // events; metaTotal=0 (older worker) falls back to the loaded length.
        this.metaTotal.set(r.meta?.total ?? 0);
        // TRUE full-set stat aggregates so the KPI cards don't undercount from the page.
        this.metaStats.set(r.meta?.stats ?? null);
        this.loading.set(false);
        this.lastSyncAt.set(Date.now());
        this.consecutiveErrors.set(0); // success → resume auto-poll
      },
      error: (err: unknown) => {
        this.loading.set(false);
        // The shared <app-error-card> owns Retry + a copyable support reference.
        this.loadError.set('Could not load audit events.');
        this.loadErrorRef.set(this.requestIdFrom(err));
        this.consecutiveErrors.update((n) => n + 1); // count toward the auto-poll cap
      },
    });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: unknown): string {
    return ((e as { error?: { error?: { request_id?: string } } } | undefined)?.error?.error?.request_id) ?? '';
  }

  /**
   * Clear the chip label. The API call is already org-wide, so this only
   * affects the visual chip (the table's site filter is an independent,
   * explicit control in the toolbar).
   */
  clearScope(): void {
    // `scopeName` is a computed (the real org label); dismissing hides the chip via
    // `scopeSlug → null` (showScopeChip flips false + @if removes it) — no label to clear.
    this.scopeSlug.set(null);
  }

  /** Toggle the expanded state for an audit row — the detail `<tr>` renders
   *  directly below the master via `expandedIds` + `@if`. */
  toggleExpand(row: AuditRow): void {
    const next = new Set(this.expandedIds());
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    this.expandedIds.set(next);
  }

  // ── Template display helpers (module fns are not template-visible) ────

  relTime(iso: string | null | undefined): string {
    return relativeTime(iso);
  }

  isoOf(v: string | null | undefined): string {
    if (!v) return '';
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
  }

  fallbackMsg(action: string): string {
    return actionToFallbackMessage(action);
  }

  metaOf(r: AuditRow): string | null {
    return r.metadata ? JSON.stringify(r.metadata, null, 2) : null;
  }

  highlightJson(src: string): string {
    return highlightJson(src);
  }

  whenLocale(r: AuditRow): string {
    if (!r.created_at) return '—';
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
  }

  actorLabel(r: AuditRow): string {
    return r.actor_id ? `${r.actor_id.slice(0, 8)}…` : 'system';
  }

  actorTitleOf(r: AuditRow): string {
    return r.actor_id ?? 'system';
  }

  targetLabel(r: AuditRow): string {
    return r.target_type || r.target_id ? `${r.target_type ?? ''}:${r.target_id ?? ''}` : '—';
  }

  // ── CSV export (RFC-4180 + formula-injection guard, CWE-1236) ─────────

  private static readonly CSV_HEADERS = [
    'action', 'message', 'created_at', 'site', 'actor_id', 'target', 'request_id', 'metadata',
  ] as const;

  /**
   * Build the full CSV body from the FILTERED row model (all rows surviving
   * the site filter, not just the current page — ag-grid export parity).
   * Pure string builder so the formula guard + quoting are unit-testable
   * without touching the DOM.
   */
  buildCsv(): string {
    const rows = this.table.getFilteredRowModel().rows.map((r) => r.original);
    const lines: string[] = [AdminAuditComponent.CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(AdminAuditComponent.CSV_HEADERS.map((h) => this.csvCell(this.cellFor(r, h))).join(','));
    }
    return lines.join('\r\n');
  }

  /** The raw value for one CSV column of a row. */
  private cellFor(r: AuditRow, header: (typeof AdminAuditComponent.CSV_HEADERS)[number]): string {
    switch (header) {
      case 'action': return r.action ?? '';
      case 'message': return r.message ?? actionToFallbackMessage(r.action);
      case 'created_at': return r.created_at ?? '';
      case 'site': return r.site ?? '';
      case 'actor_id': return r.actor_id ?? '';
      case 'target': return r.target_type || r.target_id ? `${r.target_type ?? ''}:${r.target_id ?? ''}` : '';
      case 'request_id': return r.request_id ?? '';
      case 'metadata': return r.metadata ? JSON.stringify(r.metadata) : '';
      default: return '';
    }
  }

  /** RFC-4180 quoting composed with the formula-injection guard. */
  csvCell(raw: string): string {
    const guarded = this.csvFormulaGuard(raw);
    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  }

  /** Apostrophe-prefix a cell whose value begins with a spreadsheet formula
   *  trigger (= + - @ or a leading tab/CR) so Excel/Sheets render it as text. */
  csvFormulaGuard(value: unknown): string {
    const s = value == null ? '' : String(value);
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  }

  exportCsv(): void {
    if (!this.canExport()) return; // nothing to export — never emit a headers-only CSV
    const blob = new Blob([this.buildCsv()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Copy a correlation/request ID to the clipboard with feedback so the
   * operator can paste it straight into a support ticket or Sentry search.
   */
  async copyCorrelationId(id: string): Promise<void> {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      this.toast.success('Request ID copied');
    } catch {
      this.toast.error('Could not copy — select the ID and copy manually');
    }
  }

  /**
   * Copy the entire audit row as a pretty-printed JSON payload — the
   * "give-me-the-row" button at the top-right of the detail panel for
   * incident hand-off.
   */
  async copyRowAsJson(row: AuditRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(row, null, 2));
      this.toast.success('Row JSON copied');
    } catch {
      this.toast.error('Could not copy — please select the JSON manually');
    }
  }

}
