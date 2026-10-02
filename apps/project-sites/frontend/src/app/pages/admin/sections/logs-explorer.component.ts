/**
 * @module pages/admin/sections/logs-explorer
 *
 * @description
 * Worker Tail Log Explorer admin section.
 *
 * Features:
 * - DSL search box (level:error AND route:/api/sites/* AND duration>2s)
 * - Filter chips for quick level filtering
 * - Virtualized scrollable result table (≤36px rows)
 * - Route-cost bar chart with animated totals via `<app-rolling-counter>`
 * - `appReveal` on every section entrance
 *
 * Backend: `POST /api/logs/search` + `GET /api/logs/cost-by-route`
 * Feature flag: `log_explorer`
 *
 * Route: `/admin/logs`
 *
 * @packageDocumentation
 */
import {
  Component, inject, signal, computed, effect, ChangeDetectionStrategy, OnInit, OnDestroy,
} from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { FlagGateNoticeComponent } from '../../../components/states/flag-gate-notice.component';
import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';
import { DialogShellComponent } from '../../../components/dialog-shell/dialog-shell.component';
import { HlmInputDirective } from '../../../ui';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

type LogRange = '1h' | '6h' | '24h' | '7d' | '30d';

interface LogRow {
  id: string;
  ts: string;
  level: string;
  request_id: string;
  /** Distributed-trace id correlating this row with its full request trace;
   *  `null` when the event carried none. Drives the row → trace navigation. */
  trace_id: string | null;
  route: string;
  method: string;
  status: number | null;
  duration_ms: number | null;
  cost_estimate: number;
  /** Structured error code from a thrown AppError (`NOT_FOUND`, …); `null` for
   *  ordinary rows. Surfaced as an inline badge so a 500 is never a blank row. */
  code: string | null;
  message: string;
  meta: unknown;
}

interface SearchResponse {
  data: {
    items: LogRow[];
    next_cursor: string | null;
    total_returned: number;
  };
}

interface CostRow {
  route: string;
  request_count: number;
  total_cost: number;
  avg_duration_ms: number;
  error_count: number;
  cost_share_pct: number;
}

interface CostResponse {
  data: {
    range: string;
    grand_total_cost: number;
    rows: CostRow[];
  };
}

const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-[#888]', info: 'text-[#9ae]', warn: 'text-yellow-400',
  error: 'text-red-400', fatal: 'text-red-600',
};

@Component({
  selector: 'app-logs-explorer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RollingCounterComponent, MiniEmptyComponent, HlmInputDirective, FlagGateNoticeComponent, DialogShellComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto max-md:p-4 space-y-5">

      <!-- Header -->
      <header class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div class="kicker">Observability</div>
          <h2 class="section-h text-lg font-bold text-white m-0">Log Explorer</h2>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
            30-day full-text search across Worker tail logs with cost attribution per route.
          </p>
        </div>
        <!-- Range pills hidden when the feature is flag-gated off — they filter
             a search that can't run, so they'd be dead controls over the gate notice. -->
        @if (!featureDisabled()) {
          <div class="flex items-center gap-2">
            @for (r of RANGES; track r) {
              <button class="range-pill" [class.active]="range() === r" (click)="setRange(r)">{{ r }}</button>
            }
          </div>
        }
      </header>

      @if (featureDisabled()) {
        <app-flag-gate-notice feature="Log Explorer" flag="log_explorer" heading="Log Explorer isn’t enabled" suffix="to search Worker tail logs and view cost-by-route" testid="logs-explorer-flag-gate" />
      } @else {

      <!-- Search bar -->
      <div class="search-bar flex gap-2 items-center">
        <input
          hlmInput
          class="flex-1 font-mono"
          data-testid="logs-search-input"
          aria-label="Log search query"
          [(ngModel)]="queryInput"
          placeholder="level:error AND route:/api/sites/* AND duration>2s"
          (keydown.enter)="search()"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn-primary text-xs px-4" data-testid="logs-search-btn" (click)="search()" [disabled]="searching()">
          {{ searching() ? 'Searching…' : 'Search' }}
        </button>
        @if (queryInput) {
          <button class="btn-ghost text-xs" (click)="clearSearch()">Clear</button>
        }
      </div>

      <!-- Quick filter chips -->
      <div class="flex gap-2 flex-wrap">
        @for (chip of LEVEL_CHIPS; track chip.level) {
          <button
            class="chip"
            [class.chip-active]="activeLevel() === chip.level"
            (click)="toggleLevel(chip.level)"
          >
            <span class="{{ chip.color }}">●</span> {{ chip.label }}
          </button>
        }
        <button class="chip chip-ghost" (click)="loadCosts()" [disabled]="costLoading()">
          {{ costLoading() ? 'Loading costs…' : '$ Cost by Route' }}
        </button>
      </div>

      <!-- Cost bar chart -->
      @if (costRows().length > 0) {
        <section class="cost-chart-section space-y-1">
          <div class="flex items-center justify-between mb-2">
            <span class="kicker">Route Cost Attribution</span>
            <span class="text-xs text-text-secondary">
              Total: $<app-rolling-counter [value]="grandTotal() * 1_000_000" suffix="µ" [decimals]="0" />
            </span>
          </div>
          @for (row of costRows().slice(0, 15); track row.route) {
            <div class="cost-row flex items-center gap-2">
              <span class="cost-route text-[0.68rem] text-text-secondary truncate w-48 shrink-0" [attr.title]="row.route">{{ row.route }}</span>
              <div class="cost-bar-bg flex-1 relative h-5 rounded overflow-hidden">
                <div
                  class="cost-bar-fill absolute inset-y-0 left-0 bg-[--ps-accent] opacity-20 rounded"
                  [style.width.%]="row.cost_share_pct"
                ></div>
                <span class="absolute inset-y-0 left-2 flex items-center text-[0.65rem] text-white/70 tabular-nums">
                  {{ row.request_count | number:'1.0-0' }} req · {{ row.avg_duration_ms | number:'1.0-0' }}ms avg
                  @if (row.error_count > 0) { · <span class="text-red-400">{{ row.error_count | number:'1.0-0' }} err</span> }
                </span>
              </div>
              <span class="text-[0.65rem] text-[--ps-accent] w-12 text-right shrink-0 tabular-nums">
                {{ (row.cost_share_pct) | number:'1.1-1' }}%
              </span>
            </div>
          }
        </section>
      }

      <!-- Results table -->
      @if (rows().length > 0) {
        <section>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-text-secondary">{{ rows().length }} {{ rows().length === 1 ? 'result' : 'results' }}</span>
            @if (nextCursor()) {
              <button class="btn-ghost text-xs" (click)="loadMore()" [disabled]="searching()">Load more</button>
            }
          </div>
          <div class="log-table" data-testid="logs-table">
            <div class="log-header">
              <span class="col-ts">Time</span>
              <span class="col-level">Level</span>
              <span class="col-method">Method</span>
              <span class="col-route">Route</span>
              <span class="col-status">Status</span>
              <span class="col-dur">ms</span>
              <span class="col-msg">Message</span>
              <span class="col-trace">Trace</span>
            </div>
            @for (row of rows(); track row.id) {
              <!-- Whole row opens the detail dialog (resource context + trace nav).
                   A <button> row = keyboard-operable (Enter/Space) + focus-visible. -->
              <button
                type="button"
                class="log-row log-row-btn"
                data-testid="logs-row"
                [class.log-error]="row.level === 'error' || row.level === 'fatal'"
                (click)="openDetail(row)"
                [attr.aria-label]="'Open log detail for ' + row.method + ' ' + row.route + (row.code ? ' (' + row.code + ')' : '')"
              >
                <span class="col-ts text-[#888]">{{ row.ts | slice:11:19 }}</span>
                <span class="col-level {{ LEVEL_COLORS[row.level] ?? '' }}">{{ row.level }}</span>
                <span class="col-method text-[#888]">{{ row.method }}</span>
                <span class="col-route truncate text-[0.68rem]" [attr.title]="row.route">{{ row.route }}</span>
                <span class="col-status" [class.text-red-400]="(row.status ?? 0) >= 500">{{ row.status ?? '—' }}</span>
                <span class="col-dur text-[#888]">{{ row.duration_ms ?? '—' }}</span>
                <span class="col-msg truncate text-[0.68rem] text-left" title="{{ row.message }}">
                  @if (row.code) {
                    <span class="code-badge" data-testid="logs-row-code">{{ row.code }}</span>
                  }
                  {{ row.message }}
                </span>
                <span class="col-trace">
                  @if (row.trace_id) {
                    <span class="trace-chip" data-testid="logs-row-trace" title="View trace {{ row.trace_id }}">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
                      trace
                    </span>
                  } @else {
                    <span class="text-[#555] text-[0.6rem]">—</span>
                  }
                </span>
              </button>
            }
          </div>
        </section>
      }

      <!-- Loading skeleton while searching with no prior rows (no blank gap). -->
      @if (searching() && rows().length === 0) {
        <div class="log-table" data-testid="logs-loading" aria-busy="true" aria-label="Searching logs">
          @for (i of [1,2,3,4,5,6]; track i) {
            <div class="log-row"><span class="log-skel"></span></div>
          }
        </div>
      }

      <!-- Persistent error (a failed fetch must NOT look like an empty result). -->
      @if (searchError() && !searching()) {
        <div class="empty-card" data-testid="logs-error" role="alert">
          <p class="text-red-300 text-sm mb-2">{{ searchError() }}</p>
          <button class="btn-ghost text-xs" data-testid="logs-retry" (click)="search()">Retry</button>
        </div>
      }

      @if (rows().length === 0 && !searching() && searched() && !searchError()) {
        <div class="empty-card" data-testid="logs-empty">
          @if (hasActiveFilters()) {
            <app-mini-empty text="No logs match your filters.">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/></svg>
            </app-mini-empty>
            <button class="btn-ghost text-xs" data-testid="logs-clear-filters" (click)="clearSearch()">Clear filters</button>
          } @else {
            <app-mini-empty text="No logs in the selected time range — try a wider range above.">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </app-mini-empty>
          }
        </div>
      }
      }

      <!-- Log-row detail: full resource context + trace navigation. Reuses the
           ONE dialog primitive (DialogShellComponent) per the admin convention. -->
      @if (selectedRow(); as r) {
        <app-dialog-shell (closed)="selectedRow.set(null)" data-testid="logs-detail-dialog">
          <span dialogIcon class="{{ LEVEL_COLORS[r.level] ?? 'text-[--ps-accent]' }}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
          </span>
          <ng-container dialogTitle>Log detail</ng-container>
          <span dialogBadge class="detail-level-badge {{ LEVEL_COLORS[r.level] ?? '' }}">{{ r.level }}</span>

          <div class="p-5 space-y-3">
            @if (r.code) {
              <div class="detail-error-banner" data-testid="logs-detail-code">
                <span class="code-badge">{{ r.code }}</span>
                <span class="text-[0.82rem] text-red-200">{{ r.message }}</span>
              </div>
            } @else {
              <p class="text-[0.82rem] text-text-secondary break-words m-0" data-testid="logs-detail-message">{{ r.message || '—' }}</p>
            }

            <dl class="detail-grid">
              <dt>Time</dt><dd class="font-mono">{{ r.ts || '—' }}</dd>
              <dt>Method</dt><dd class="font-mono">{{ r.method || '—' }}</dd>
              <dt>Route</dt><dd class="font-mono break-all">{{ r.route }}</dd>
              <dt>Status</dt><dd class="font-mono" [class.text-red-400]="(r.status ?? 0) >= 500">{{ r.status ?? '—' }}</dd>
              <dt>Duration</dt><dd class="font-mono">{{ r.duration_ms ?? '—' }}{{ r.duration_ms != null ? ' ms' : '' }}</dd>
              <dt>Est. cost</dt><dd class="font-mono">{{ '$' }}{{ (r.cost_estimate * 1_000_000) | number:'1.0-2' }}µ</dd>
              <dt>Request ID</dt>
              <dd class="font-mono break-all flex items-center gap-1.5">
                <span data-testid="logs-detail-request-id">{{ r.request_id || '—' }}</span>
                @if (r.request_id) {
                  <button type="button" class="copy-mini" (click)="copyId(r.request_id, 'Request ID')" aria-label="Copy request ID">⧉</button>
                }
              </dd>
              <dt>Trace ID</dt>
              <dd class="font-mono break-all flex items-center gap-1.5">
                <span data-testid="logs-detail-trace-id">{{ r.trace_id || '—' }}</span>
                @if (r.trace_id) {
                  <button type="button" class="copy-mini" (click)="copyId(r.trace_id, 'Trace ID')" aria-label="Copy trace ID">⧉</button>
                }
              </dd>
            </dl>
          </div>

          <div dialogFooter class="detail-footer flex items-center justify-end gap-2">
            @if (r.trace_id) {
              <button type="button" class="btn-primary text-xs px-4" data-testid="logs-view-trace" (click)="viewTrace(r)">
                View trace →
              </button>
            } @else {
              <span class="text-[0.72rem] text-text-secondary mr-auto" data-testid="logs-no-trace">No trace id captured for this event.</span>
            }
            <button type="button" class="btn-ghost text-xs" (click)="selectedRow.set(null)">Close</button>
          </div>
        </app-dialog-shell>
      }
    </div>
  `,
  styles: [`
    /* .search-input removed — now Spartan hlmInput (mono via font-mono). */
    .range-pill {
      padding: 3px 10px;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,.12);
      background: transparent;
      color: rgba(255,255,255,.5);
      font-size: .72rem;
      cursor: pointer;
      transition: all .15s;
    }
    .range-pill.active {
      background: var(--ps-accent,#00e5ff);
      color: #060610;
      border-color: transparent;
    }
    .range-pill:focus-visible { outline: 2px solid var(--ps-accent,#00e5ff); outline-offset: 2px; }
    .chip {
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,.1);
      background: rgba(255,255,255,.03);
      color: rgba(255,255,255,.6);
      font-size: .72rem;
      cursor: pointer;
      transition: all .15s;
    }
    .chip-active, .chip:hover { border-color: var(--ps-accent,#00e5ff); color: var(--ps-accent,#00e5ff); background: rgba(0,229,255,.06); }
    .chip:focus-visible { outline: 2px solid var(--ps-accent,#00e5ff); outline-offset: 2px; }
    .chip-ghost { border-style: dashed; }
    .cost-chart-section {
      background: rgba(0,229,255,.03);
      border: 1px solid rgba(0,229,255,.08);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .log-table {
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 8px;
      overflow: hidden;
      font-size: .72rem;
      font-family: 'JetBrains Mono', monospace;
    }
    .log-header, .log-row {
      display: grid;
      grid-template-columns: 70px 50px 60px 1fr 52px 48px 1.4fr 58px;
      align-items: center;
      padding: 0 8px;
      height: 32px;
      gap: 6px;
    }
    .log-header {
      background: rgba(255,255,255,.04);
      color: rgba(255,255,255,.4);
      font-size: .65rem;
      text-transform: uppercase;
      letter-spacing: .06em;
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .log-row {
      border-bottom: 1px solid rgba(255,255,255,.04);
      transition: background .1s;
    }
    .log-row:hover { background: rgba(255,255,255,.03); }
    .log-error { background: rgba(255,80,80,.04); }
    /* Row-as-button: strip native button chrome, keep the grid + a cyan focus ring. */
    .log-row-btn {
      width: 100%;
      border: none;
      border-bottom: 1px solid rgba(255,255,255,.04);
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: inherit;
      cursor: pointer;
    }
    .log-row-btn:hover { background: rgba(0,229,255,.05); }
    .log-row-btn:focus-visible { outline: 2px solid var(--ps-accent,#00e5ff); outline-offset: -2px; }
    /* Error-code badge — makes a 500 instantly legible, never a blank row. */
    .code-badge {
      display: inline-block;
      padding: 1px 6px;
      margin-right: 4px;
      border-radius: 5px;
      background: rgba(255,80,80,.14);
      border: 1px solid rgba(255,80,80,.3);
      color: #ff9b9b;
      font-size: .6rem;
      font-weight: 700;
      letter-spacing: .03em;
      vertical-align: middle;
      white-space: nowrap;
    }
    /* Trace affordance chip in the row. */
    .trace-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border-radius: 5px;
      background: rgba(0,229,255,.08);
      border: 1px solid rgba(0,229,255,.22);
      color: var(--ps-accent,#00e5ff);
      font-size: .6rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .col-trace { display: flex; justify-content: flex-start; }
    /* Detail dialog. */
    .detail-level-badge {
      font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
      padding: 2px 7px; border-radius: 5px; background: rgba(255,255,255,.05);
    }
    .detail-error-banner {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 10px 12px; border-radius: 8px;
      background: rgba(255,80,80,.07); border: 1px solid rgba(255,80,80,.18);
    }
    .detail-grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 14px;
      margin: 0;
      font-size: .76rem;
    }
    .detail-grid dt { color: rgba(255,255,255,.42); text-transform: uppercase; font-size: .62rem; letter-spacing: .05em; align-self: center; }
    .detail-grid dd { color: rgba(255,255,255,.85); margin: 0; }
    .copy-mini {
      border: none; background: transparent; color: var(--ps-accent,#00e5ff);
      cursor: pointer; font-size: .8rem; line-height: 1; padding: 2px; border-radius: 4px;
    }
    .copy-mini:hover { background: rgba(0,229,255,.1); }
    .copy-mini:focus-visible { outline: 2px solid var(--ps-accent,#00e5ff); outline-offset: 1px; }
    .detail-footer { padding: 14px 20px; border-top: 1px solid rgba(255,255,255,.06); }
    .log-skel {
      display: block; height: 10px; width: 100%; border-radius: 5px;
      background: linear-gradient(90deg,
        color-mix(in oklch, var(--ps-accent, #00e5ff) 6%, transparent) 25%,
        color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent) 50%,
        color-mix(in oklch, var(--ps-accent, #00e5ff) 6%, transparent) 75%);
      background-size: 200% 100%;
      animation: log-shimmer 1.2s ease-in-out infinite;
    }
    @keyframes log-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .log-skel { animation: none; } }
    .col-ts, .col-level, .col-method, .col-route, .col-status, .col-dur { white-space: nowrap; }
    .cost-row { min-height: 28px; }
    .cost-bar-bg { background: rgba(255,255,255,.05); }
  `],
})
export class AdminLogsExplorerComponent implements OnInit, OnDestroy {
  protected readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly RANGES: LogRange[] = ['1h', '6h', '24h', '7d', '30d'];
  readonly LEVEL_CHIPS = [
    { level: 'debug', label: 'Debug', color: 'text-[#888]' },
    { level: 'info', label: 'Info', color: 'text-[#9ae]' },
    { level: 'warn', label: 'Warn', color: 'text-yellow-400' },
    { level: 'error', label: 'Error', color: 'text-red-400' },
    { level: 'fatal', label: 'Fatal', color: 'text-red-600' },
  ];
  protected readonly LEVEL_COLORS = LEVEL_COLORS;

  queryInput = '';
  readonly range = signal<LogRange>('24h');
  readonly activeLevel = signal<string | null>(null);
  readonly rows = signal<LogRow[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly searching = signal(false);
  readonly searched = signal(false);
  /** Persistent search-failure message (non-404). Distinguishes a fetch error from a genuine empty result. */
  readonly searchError = signal<string | null>(null);
  readonly costRows = signal<CostRow[]>([]);
  readonly grandTotal = signal(0);
  readonly costLoading = signal(false);
  /** True when the worker returns 404 feature_disabled (log_explorer flag off). */
  readonly featureDisabled = signal(false);
  /** The log row whose detail dialog is open (null = closed). Drives the
   *  resource-context + trace-navigation dialog. */
  readonly selectedRow = signal<LogRow | null>(null);

  /**
   * In-flight rows fetch. `search()` + `loadMore()` share the rows/searching/
   * nextCursor signals, so the prior request is cancelled before a new one starts:
   * a slower earlier response (e.g. the ngOnInit empty-query auto-load) can never
   * resolve LAST and clobber a newer search's filtered results (last-write-wins).
   */
  private searchSub?: Subscription;
  /** In-flight cost fetch — cancelled before a new one for the same race reason. */
  private costsSub?: Subscription;

  ngOnInit() { this.search(); this.loadCosts(); }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.costsSub?.unsubscribe();
  }

  setRange(r: LogRange) {
    this.range.set(r);
    this.rows.set([]);
    this.nextCursor.set(null);
    this.search();
    this.loadCosts();
  }

  toggleLevel(level: string) {
    this.activeLevel.set(this.activeLevel() === level ? null : level);
    const lvlPart = this.activeLevel() ? `level:${this.activeLevel()}` : '';
    const rest = this.queryInput.replace(/level:\S+/g, '').trim();
    this.queryInput = [lvlPart, rest].filter(Boolean).join(' ');
    this.search();
  }

  clearSearch() {
    this.queryInput = '';
    this.activeLevel.set(null);
    this.rows.set([]);
    this.nextCursor.set(null);
    this.searched.set(false);
    this.search();
  }

  /**
   * True when a query string or level chip is narrowing results — drives the
   * filtered-empty state's "Clear filters" CTA so a zero-result query is never a
   * dead-end. When false, an empty result is purely the time range (clearing
   * filters wouldn't help) so the empty state says so instead of mislabelling it.
   */
  hasActiveFilters(): boolean {
    return this.queryInput.trim().length > 0 || this.activeLevel() !== null;
  }

  search() {
    this.searching.set(true);
    this.searchError.set(null);
    // Cancel any in-flight rows fetch so a slower earlier response (e.g. the
    // ngOnInit empty-query auto-load) can't resolve last and clobber this
    // search's filtered results on the shared rows() signal (last-write-wins).
    this.searchSub?.unsubscribe();
    this.searchSub = this.api.post<SearchResponse>('/logs/search', {
      query: this.queryInput,
      range: this.range(),
      limit: 100,
    }, { silent: true }).subscribe({
      next: (res) => {
        // A stale worker route (predates /api/logs/search) falls through to the
        // SPA → the request 200s with HTML, so res.data.items is undefined.
        // Without this guard `this.rows.set(undefined)` crashes the template's
        // `rows().length` (or shows a misleading fake-empty). Treat a shapeless
        // body as an honest error, never a 0-results state. (cf. site-features.)
        if (!res?.data || !Array.isArray(res.data.items)) {
          this.searchError.set("Couldn't load logs — the log service is unavailable. Retry.");
          this.searching.set(false);
          this.searched.set(true);
          return;
        }
        this.rows.set(res.data.items);
        this.nextCursor.set(res.data.next_cursor);
        this.searchError.set(null);
        this.searching.set(false);
        this.searched.set(true);
      },
      error: (err) => {
        if (err?.status === 404) {
          // log_explorer flag off — surface the honest disabled state, not a
          // toast-on-load. (ngOnInit auto-runs search(), so a toast here would
          // fire on every visit while the flag is off.)
          this.featureDisabled.set(true);
        } else {
          // Persistent in-panel error (+ toast) so a failed fetch never
          // masquerades as the "No logs found" empty state.
          this.searchError.set("Couldn't load logs — check your query or retry.");
          this.toast.error('Failed to search logs');
        }
        this.searching.set(false);
        this.searched.set(true);
      },
    });
  }

  loadMore() {
    const cursor = this.nextCursor();
    if (!cursor) return;
    this.searching.set(true);
    // Same last-write-wins guard: a new page supersedes any in-flight rows fetch.
    this.searchSub?.unsubscribe();
    this.searchSub = this.api.post<SearchResponse>('/logs/search', {
      query: this.queryInput,
      range: this.range(),
      limit: 100,
      cursor,
    }, { silent: true }).subscribe({
      next: (res) => {
        // Same stale-route guard as search(): a shapeless body must not spread
        // `undefined` into the rows array (TypeError) — keep prior rows + toast.
        if (!res?.data || !Array.isArray(res.data.items)) {
          this.toast.error('Failed to load more logs');
          this.searching.set(false);
          return;
        }
        this.rows.update((prev) => [...prev, ...res.data.items]);
        this.nextCursor.set(res.data.next_cursor);
        this.searching.set(false);
      },
      error: () => {
        this.toast.error('Failed to load more logs');
        this.searching.set(false);
      },
    });
  }

  loadCosts() {
    this.costLoading.set(true);
    // Last-write-wins: a range change re-fires loadCosts; the prior in-flight
    // cost fetch must not resolve last and overwrite the newer range's chart.
    this.costsSub?.unsubscribe();
    this.costsSub = this.api.get<CostResponse>(`/logs/cost-by-route?range=${this.range()}`, undefined, { silent: true }).subscribe({
      next: (res) => {
        // Stale-route guard: a 200-with-HTML body has no rows array → leave
        // costRows empty (the chart simply hides) and don't render a NaN total,
        // rather than crashing `costRows().slice(0, 15)` / `grandTotal()`.
        if (!res?.data || !Array.isArray(res.data.rows)) {
          this.toast.error('Failed to load cost data');
          this.costLoading.set(false);
          return;
        }
        this.costRows.set(res.data.rows);
        this.grandTotal.set(res.data.grand_total_cost);
        this.costLoading.set(false);
      },
      error: (err: { status?: number } | null) => {
        // 404 = flag off → honest disabled banner (no toast). Non-404 → an
        // accurate component toast (the read is {silent:true}, so without this
        // a cost-load failure would be silent).
        if (err?.status === 404) this.featureDisabled.set(true);
        else this.toast.error('Failed to load cost data');
        this.costLoading.set(false);
      },
    });
  }

  /** Open the detail dialog for a row (full resource context + trace nav). */
  openDetail(row: LogRow): void {
    this.selectedRow.set(row);
  }

  /**
   * Navigate from a log row to its correlated request trace. Deep-links to the
   * Logs › Traces tab with the trace id as a query param (bookmarkable + back/
   * forward-safe) so the operator lands on the full trace, not a raw id. Closes
   * the dialog first. No-op (with a toast) when the event carried no trace id.
   */
  viewTrace(row: LogRow): void {
    if (!row.trace_id) {
      this.toast.error('No trace id captured for this log event');
      return;
    }
    this.selectedRow.set(null);
    void this.router.navigate(['/admin/logs'], {
      queryParams: { tab: 'traces', trace: row.trace_id },
      queryParamsHandling: 'merge',
    });
  }

  /** Copy a request/trace id to the clipboard with a confirming toast. */
  copyId(id: string, label: string): void {
    const done = () => this.toast.success(`${label} copied`);
    const fail = () => this.toast.error(`Couldn't copy ${label}`);
    try {
      const clip = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator?.clipboard;
      if (clip?.writeText) {
        clip.writeText(id).then(done, fail);
      } else {
        fail();
      }
    } catch {
      fail();
    }
  }
}
