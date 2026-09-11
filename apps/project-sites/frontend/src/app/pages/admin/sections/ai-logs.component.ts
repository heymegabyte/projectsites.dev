import {
  Component,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  type ElementRef,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { HlmInputDirective, HlmTablistDirective } from '../../../ui';
import {
  createAngularTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  type ColumnDef,
  type PaginationState,
  type SortingState,
} from '@tanstack/angular-table';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';

/**
 * One AI invocation as returned by `GET /api/sites/:id/ai-logs`.
 */
interface TraceRow {
  id: string;
  submission_id: string | null;
  trace_kind: string;
  endpoint_slug: string | null;
  model: string;
  status: string;
  latency_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  credits_debited: number | null;
  tool_name: string | null;
  tool_status: string | null;
  output_preview: string | null;
  error_message: string | null;
  created_at: string;
  actor_email?: string | null;
  user_id?: string | null;
}

/** Lazy-fetched full trace detail — system prompt + IO + tool. */
interface TraceDetail extends TraceRow {
  prompt_template: string | null;
  input_json: string;
  output_text: string | null;
  output_json: string | null;
  tool_args_json: string | null;
  tool_result_json: string | null;
}

/** Period selector value driving the latency-percentile chart x-axis. */
type ChartPeriod = '1h' | '24h' | '7d' | '30d';

/**
 * Escape an arbitrary string into an HTML-safe fragment. Used for every
 * dynamic value rendered via `[innerHTML]` (the JSON + system-prompt
 * highlighters) below — never trust trace data, even from our own backend.
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
 * booleans violet, null grey. Mirrors the audit component's pattern so the
 * two log surfaces share one colour vocabulary.
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

/**
 * Highlight ALL-CAPS structural headings (ROLE, OUTPUT, SAFETY, INPUT, etc.)
 * inside a system prompt so the long-form prose is scannable. Lines that look
 * like a heading (≥3 uppercase letters followed by `:` or end-of-line) get a
 * keyword span.
 */
function highlightSystemPrompt(src: string): string {
  return escapeHtml(src).replace(
    /^([A-Z][A-Z0-9 _-]{2,30})(:|$)/gm,
    (_m, head: string, tail: string) => `<span class="kw">${head}</span>${tail}`,
  );
}

/**
 * Collapse the verbose Workers AI model slug (`@cf/meta/llama-3.3-70b-instruct`)
 * down to a human-readable label (`Llama 3.3 70B`). Falls back to the raw value
 * for unrecognised slugs (e.g. external OpenAI / Anthropic models).
 */
function prettifyModel(slug: string | null | undefined): string {
  if (!slug) return '—';
  const m = slug.match(/llama-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)b/i);
  if (m) return `Llama ${m[1]} ${m[2]}B`;
  if (/^gpt-4o/i.test(slug)) return 'GPT-4o';
  if (/^gpt-4/i.test(slug)) return 'GPT-4';
  if (/^claude-opus/i.test(slug)) return 'Claude Opus';
  if (/^claude-sonnet/i.test(slug)) return 'Claude Sonnet';
  if (/^claude-haiku/i.test(slug)) return 'Claude Haiku';
  return slug.split('/').pop() ?? slug;
}

/** Format latency: <1000 → "Xms", else "X.Ys". */
function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Map latency to a fill-color band for the latency-progress cell. */
function latencyBand(ms: number | null | undefined): 'good' | 'mid' | 'bad' {
  if (ms == null) return 'good';
  if (ms > 1000) return 'bad';
  if (ms > 500) return 'mid';
  return 'good';
}

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

/** Trim a `user_id` to the leading 8 chars when no email is present. */
function fallbackActor(row: TraceRow): string {
  if (row.actor_email) return row.actor_email;
  if (row.user_id) return row.user_id.slice(0, 8);
  return '—';
}

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

/**
 * Admin AI-trace surface (`/admin/ai-logs`). Renders the site's AI traces as
 * a native TanStack Table view (perf-wave ag-grid→TanStack migration,
 * 2026-08-20 — removes the critical `aria-required-children` axe violation
 * that was fundamental to ag-grid's `.ag-root[role="grid"]` structure).
 *
 * ## Master/detail
 *
 * Clicking a master row flips its id in `expandedIds`; a real Angular
 * `<tr class="detail-row">` renders directly below (colspan across all
 * eight columns) with the cinematic metric-pill header, system prompt /
 * input / output-or-error / tool code blocks (each with a copy chip), the
 * AI-explanation block, and the Re-run / Explain / Copy JSON / Open endpoint
 * action row. The full trace detail is lazy-fetched on first expand and
 * cached per id; the panel is ordinary template DOM, so it participates in
 * Angular change detection and is natively axe-clean.
 *
 * @example
 * ```html
 * <app-admin-ai-logs />
 * <!-- Renders the TanStack trace table + latency-percentile chart + filter row. -->
 * ```
 */
@Component({
  selector: 'app-admin-ai-logs',
  standalone: true,
  imports: [RollingCounterComponent, RevealDirective, HlmInputDirective, HlmTablistDirective],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-4">
      <header class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="kicker">Observability</div>
          <h2 class="section-h text-lg font-bold text-white m-0 flex items-center gap-3">
            AI Traces
            <span class="live-pill" [class.live-pill--paused]="!polling()" [title]="polling() ? 'Polling every 15s' : (autoRefreshPaused() ? 'Auto-refresh paused after repeated errors — use Retry' : 'Polling paused (tab hidden)')">
              <span class="live-dot" aria-hidden="true"></span>
              <span class="live-text">{{ polling() ? 'Live' : (autoRefreshPaused() ? 'Auto-paused' : 'Paused') }}</span>
            </span>
          </h2>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
            Every AI invocation — system prompt, input, output, tool dispatch. Click any row to expand the full trace inline.
          </p>
        </div>
      </header>

      <!-- KPI tiles ──────────────────────────────────────────────────── -->
      <!-- Hidden when the load errored with no data — definitive "0 calls · 0ms
           · 0 errors · 0 credits" over the error card is wrong (unknown, not 0).
           Stale data still shows them. Mirrors the marketplace/site-dna fix. -->
      @if (showKpis()) {
      <div class="grid grid-cols-4 gap-3 text-[0.78rem]">
        <div class="card" appReveal><div class="muted-h">Calls</div><div class="text-2xl font-bold text-white"><app-rolling-counter [value]="rows().length" [duration]="1100" /></div></div>
        <div class="card" appReveal><div class="muted-h">Avg latency</div><div class="text-2xl font-bold text-white">@if (avgLatency() < 1000) { <app-rolling-counter [value]="avgLatency()" suffix="ms" [duration]="1100" /> } @else { <app-rolling-counter [value]="avgLatency() / 1000" [decimals]="1" suffix="s" [duration]="1100" /> }</div></div>
        <div class="card" appReveal><div class="muted-h">Errors</div><div class="text-2xl font-bold" [class.text-red-400]="errors() > 0" [class.text-white]="errors() === 0"><app-rolling-counter [value]="errors()" [duration]="1100" /></div></div>
        <div class="card" appReveal><div class="muted-h">Credits used</div><div class="text-2xl font-bold text-white"><app-rolling-counter [value]="totalCredits()" [duration]="1100" /></div></div>
      </div>
      }

      @if (hasHiddenCalls()) {
        <p class="text-[0.7rem] text-amber-300/90 mt-1" role="status" data-testid="ai-logs-cap-note"
           title="The stats + table cover the {{ rows().length }} most recent AI calls. Older ones are still stored.">
          Showing the latest {{ rows().length }} of {{ totalCount() }} AI calls — the stats above cover this window.
        </p>
      }

      @if (loadError() && rows().length === 0 && !loading()) {
        <div class="card" role="alert" data-testid="ai-logs-load-error">
          <p class="text-red-300 text-sm m-0 mb-2">{{ loadError() }}</p>
          <button class="btn-ghost text-xs" data-testid="ai-logs-retry" (click)="reload()">Retry</button>
        </div>
      }

      @if (gridLoadingSkeleton()) {
        <div class="card" data-testid="ai-logs-skeleton" aria-busy="true" aria-label="Loading AI traces">
          <div class="sk-line sk-line--head"></div>
          @for (n of [1,2,3,4,5]; track n) { <div class="sk-line"></div> }
        </div>
      } @else if (gridEmpty()) {
        <div class="card text-center py-10" data-testid="ai-logs-empty">
          <div class="empty-glyph" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          </div>
          <p class="text-white text-sm font-semibold m-0 mt-3">No AI traces yet</p>
          <p class="text-text-secondary text-[0.78rem] m-0 mt-1 max-w-sm mx-auto">
            Every AI invocation this site makes — prompts, outputs, tool calls — will appear here in real time.
          </p>
          <button class="btn-ghost text-xs mt-4" data-testid="ai-logs-empty-refresh" (click)="reload()">Refresh</button>
        </div>
      }

      <!-- Latency percentile chart (p50/p95/p99 stacked-area) ────────── -->
      @if (rows().length > 0) {
        <section class="card" appReveal>
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div>
              <h3 class="m-0 text-base font-semibold text-white">Latency percentiles</h3>
              <p class="text-[0.7rem] text-text-secondary m-0 mt-0.5" data-testid="ai-logs-chart-subtitle">p50 / p95 / p99 over {{ chartPeriodLabel() }} · {{ windowSampleCount() }} {{ windowSampleCount() === 1 ? 'trace' : 'traces' }} · {{ chartBins().length }} bins</p>
            </div>
            <div class="period-pills" role="tablist" hlmTablist aria-label="Chart period">
              @for (p of periods; track p.id) {
                <button
                  type="button"
                  role="tab"
                  class="period-pill"
                  [class.active]="chartPeriod() === p.id"
                  [attr.data-testid]="'traces-period-' + p.id"
                  [attr.aria-selected]="chartPeriod() === p.id"
                  (click)="chartPeriod.set(p.id)">
                  {{ p.label }}
                </button>
              }
            </div>
          </div>
          <svg viewBox="0 0 600 140" preserveAspectRatio="none" class="w-full h-32 chart-svg">
            <defs>
              <linearGradient id="p50grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#00E5FF" stop-opacity="0.55"/>
                <stop offset="100%" stop-color="#00E5FF" stop-opacity="0"/>
              </linearGradient>
              <linearGradient id="p95grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#7C3AED" stop-opacity="0.50"/>
                <stop offset="100%" stop-color="#7C3AED" stop-opacity="0"/>
              </linearGradient>
              <linearGradient id="p99grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.45"/>
                <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <!-- Drawn back-to-front: p99 widest band → p95 → p50 on top. -->
            <path [attr.d]="chartAreaPath('p99')" fill="url(#p99grad)" />
            <path [attr.d]="chartAreaPath('p95')" fill="url(#p95grad)" />
            <path [attr.d]="chartAreaPath('p50')" fill="url(#p50grad)" />
            <path [attr.d]="chartLinePath('p99')" fill="none" stroke="#fbbf24" stroke-width="1.4" stroke-opacity="0.85"/>
            <path [attr.d]="chartLinePath('p95')" fill="none" stroke="#7C3AED" stroke-width="1.6" stroke-opacity="0.92"/>
            <path [attr.d]="chartLinePath('p50')" fill="none" stroke="#00E5FF" stroke-width="2"/>
          </svg>
          <div class="chart-legend">
            <span class="lg-dot lg-p50"></span>p50 {{ formatLatencyMs(currentP(50)) }}
            <span class="lg-dot lg-p95"></span>p95 {{ formatLatencyMs(currentP(95)) }}
            <span class="lg-dot lg-p99"></span>p99 {{ formatLatencyMs(currentP(99)) }}
          </div>
        </section>
      }

      @if (rows().length > 0) {
      <!-- Quick-filter search box (focus on '/') ───────────────────────── -->
      <label class="filter-shell" [class.is-focused]="searchFocused()">
        <svg class="filter-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/>
        </svg>
        <input
          #filterInput
          hlmInput
          [seamless]="true"
          data-testid="traces-filter"
          type="text"
          class="flex-1"
          placeholder="Filter traces — endpoint, tool, model, actor, preview…"
          [value]="filter()"
          (input)="filter.set(asInputValue($event))"
          (focus)="searchFocused.set(true)"
          (blur)="searchFocused.set(false)"
          aria-label="Filter traces"
        />
        <kbd class="filter-kbd" aria-hidden="true">/</kbd>
      </label>

      <!-- Full-bleed TanStack trace table ─────────────────────────────── -->
      <div class="grid-frame">
        <div class="grid-toolbar">
          <span class="page-count" role="status" data-testid="traces-page-count">
            Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredCount() }}
          </span>
        </div>

        <table class="ps-traces-grid" data-testid="traces-grid">
          <colgroup>
            <col class="col-status" />
            <col class="col-when" />
            <col class="col-endpoint" />
            <col class="col-tool" />
            <col class="col-model" />
            <col class="col-latency" />
            <col class="col-credits" />
            <col class="col-actor" />
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
                  <th scope="col" [class.th-num]="header.id === 'credits' || header.id === 'latency_ms'">{{ headerLabel[header.id] }}</th>
                }
              }
            </tr>
          </thead>
          <tbody>
            @for (row of table.getRowModel().rows; track row.original.id) {
              <tr
                class="master-row"
                [class.is-expanded]="expandedIds().has(row.original.id)"
                (click)="onRowClick($event, row.original)">
                <td class="cell-status">
                  <span class="cell-status-pill" [class.ok]="statusPillClass(row.original) === 'ok'" [class.error]="statusPillClass(row.original) === 'error'" [class.rate]="statusPillClass(row.original) === 'rate'" [class.timeout]="statusPillClass(row.original) === 'timeout'"><span class="dot" aria-hidden="true"></span>{{ statusLabel(row.original) }}</span>
                </td>
                <td class="cell-when" [title]="isoOf(row.original.created_at)">{{ relTime(row.original.created_at) }}</td>
                <td class="cell-mono">{{ endpointLabel(row.original) }}</td>
                <td class="cell-mono">{{ row.original.tool_name ?? '—' }}</td>
                <td>{{ prettyModel(row.original.model) }}</td>
                <td class="cell-latency">
                  <div class="latency-cell">
                    <span class="lat-fill" [class.good]="latBandOf(row.original) === 'good'" [class.mid]="latBandOf(row.original) === 'mid'" [class.bad]="latBandOf(row.original) === 'bad'" [style.width]="latFillWidth(row.original)"></span>
                    <span class="lat-val">{{ fmtLatency(row.original.latency_ms) }}</span>
                  </div>
                </td>
                <td class="cell-num">{{ creditsLabel(row.original) }}</td>
                <td class="cell-mono" [title]="actorTitleOf(row.original)">{{ actorLabel(row.original) }}</td>
              </tr>
              @if (expandedIds().has(row.original.id)) {
                <tr class="detail-row" [attr.data-testid]="'traces-detail-' + row.original.id">
                  <td [attr.colspan]="columnCount">
                    <div class="detail-card">
                      @if (detailFor(row.original.id); as d) {
                        <div class="det-meta">
                          @if (d.latency_ms != null) {
                            <span class="met-pill is-lat" title="End-to-end latency">latency<span class="met-val">{{ fmtLatency(d.latency_ms) }}</span></span>
                          }
                          @if (d.credits_debited != null && d.credits_debited > 0) {
                            <span class="met-pill is-cost" title="Credits debited">cost<span class="met-val">{{ formatNumber(d.credits_debited) }}</span></span>
                          }
                          @if (tokensOf(d) > 0) {
                            <span class="met-pill is-tok" [title]="(d.tokens_input ?? 0) + ' in · ' + (d.tokens_output ?? 0) + ' out'">tokens<span class="met-val">{{ formatNumber(tokensOf(d)) }}</span></span>
                          }
                          @if (d.model) {
                            <span class="met-pill is-model" [title]="d.model">model<span class="met-val">{{ prettyModel(d.model) }}</span></span>
                          }
                          @if (d.tool_name) {
                            <span class="met-pill is-tool" title="Tool dispatch">tool<span class="met-val">{{ d.tool_name }}</span></span>
                          }
                        </div>
                        <div class="detail-grid">
                          @if (d.prompt_template) {
                            <div class="det-block kind-prompt">
                              <div class="det-head">
                                <span class="det-label"><span aria-hidden="true">●</span> System prompt</span>
                                <button type="button" class="det-copy" [attr.data-testid]="'traces-copy-prompt-' + row.original.id" aria-label="Copy System prompt" (click)="copyChip($event, d.prompt_template)">Copy</button>
                              </div>
                              <pre [innerHTML]="promptHtml(d.prompt_template)"></pre>
                            </div>
                          } @else {
                            <div class="det-block kind-prompt">
                              <div class="det-head"><span class="det-label"><span aria-hidden="true">●</span> System prompt</span></div>
                              <div class="det-value dim-italic">No system prompt captured.</div>
                            </div>
                          }
                          <div class="det-block kind-input">
                            <div class="det-head">
                              <span class="det-label"><span aria-hidden="true">●</span> Input payload</span>
                              <button type="button" class="det-copy" [attr.data-testid]="'traces-copy-input-' + row.original.id" aria-label="Copy Input payload" (click)="copyChip($event, prettyJson(d.input_json))">Copy</button>
                            </div>
                            <pre [innerHTML]="highlightJson(prettyJson(d.input_json))"></pre>
                          </div>
                          @if (d.error_message) {
                            <div class="det-block kind-error">
                              <div class="det-head">
                                <span class="det-label"><span aria-hidden="true">▲</span> Error</span>
                                <button type="button" class="det-copy" [attr.data-testid]="'traces-copy-error-' + row.original.id" aria-label="Copy error" (click)="copyChip($event, d.error_message)">Copy</button>
                              </div>
                              <pre class="error-pre">{{ d.error_message }}</pre>
                            </div>
                          } @else {
                            <div class="det-block kind-output">
                              <div class="det-head">
                                <span class="det-label"><span aria-hidden="true">●</span> Output text</span>
                                <button type="button" class="det-copy" [attr.data-testid]="'traces-copy-output-' + row.original.id" aria-label="Copy Output text" (click)="copyChip($event, outputText(d))">Copy</button>
                              </div>
                              <pre>{{ outputText(d) || '—' }}</pre>
                            </div>
                          }
                          @if (d.tool_name) {
                            <div class="det-block kind-tool">
                              <div class="det-head">
                                <span class="det-label"><span aria-hidden="true">⚙</span> Tool · {{ d.tool_name }} · {{ d.tool_status ?? '' }}</span>
                                <button type="button" class="det-copy" [attr.data-testid]="'traces-copy-tool-' + row.original.id" aria-label="Copy tool result" (click)="copyChip($event, prettyJson(d.tool_result_json) || prettyJson(d.tool_args_json) || '{}')">Copy</button>
                              </div>
                              <pre [innerHTML]="highlightJson(prettyJson(d.tool_args_json) || '{}')"></pre>
                              <pre [innerHTML]="highlightJson(prettyJson(d.tool_result_json) || '{}')"></pre>
                            </div>
                          }
                          @if (explainFor(row.original.id); as explanation) {
                            <div class="det-block kind-explain">
                              <div class="det-head">
                                <span class="det-label"><span aria-hidden="true">✦</span> AI explanation</span>
                              </div>
                              <div class="det-explain" [attr.data-testid]="'traces-explain-result-' + row.original.id">{{ explanation }}</div>
                            </div>
                          }
                          <div class="det-actions">
                            <button
                              type="button"
                              class="det-action violet"
                              [disabled]="explainingFor(row.original.id)"
                              [attr.data-testid]="'traces-explain-' + row.original.id"
                              (click)="explainTrace(row.original.id)">
                              @if (explainingFor(row.original.id)) {
                                <span aria-hidden="true">◐</span> Asking AI…
                              } @else {
                                <span aria-hidden="true">✦</span> Explain with AI
                              }
                            </button>
                            <button
                              type="button"
                              class="det-action ghost"
                              [attr.data-testid]="'traces-copy-json-' + row.original.id"
                              (click)="copyTrace(d)">
                              <span aria-hidden="true">⧉</span> Copy JSON
                            </button>
                          </div>
                        </div>
                      } @else {
                        <div class="detail-grid">
                          <div class="det-block kind-prompt">
                            <div class="det-head"><span class="det-label"><span aria-hidden="true">◐</span> Loading trace…</span></div>
                            <pre style="opacity:0.55">Fetching system prompt, input payload, output text, tool dispatch…</pre>
                          </div>
                        </div>
                      }
                    </div>
                  </td>
                </tr>
              }
            } @empty {
              <tr class="filtered-empty-row">
                <td [attr.colspan]="columnCount">
                  <div class="filtered-empty" role="status">No traces match this filter.</div>
                </td>
              </tr>
            }
          </tbody>
        </table>

        <div class="grid-footer">
          <label for="traces-page-size" class="page-size-label">
            <select id="traces-page-size" class="site-select" aria-label="Rows per page" (change)="onPageSize($event)">
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
    .muted-h { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); font-weight: 700; margin-bottom: 0.3rem; }
    .btn-ghost { padding: 0.5rem 1rem; border-radius: 8px; background: transparent; color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); cursor: pointer; font-size: 0.74rem; }
    .btn-mini { padding: 0.2rem 0.55rem; border-radius: 6px; background: rgba(0,229,255,0.12); border: 1px solid rgba(0,229,255,0.30); color: #00E5FF; font-size: 0.62rem; font-weight: 700; cursor: pointer; letter-spacing: 0.04em; text-transform: uppercase; transition: background 140ms ease; }
    .btn-mini:hover:not(:disabled) { background: rgba(0,229,255,0.22); }
    .btn-mini:disabled { opacity: 0.45; cursor: not-allowed; }

    /* ─── Loading skeleton + empty state ─────────────────────────────── */
    .sk-line { height: 14px; border-radius: 6px; margin: 10px 0; background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(0,229,255,0.10) 50%, rgba(255,255,255,0.04) 75%); background-size: 200% 100%; animation: skShimmer 1.4s ease-in-out infinite; }
    .sk-line--head { width: 38%; height: 18px; margin-bottom: 18px; }
    @keyframes skShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    /* Cockpit empty-state glyph: SVG in a circular cyan halo (matches media /
       pseo / billing) — replaces the off-standard floating unicode char. */
    .empty-glyph { width: 56px; height: 56px; margin-inline: auto; display: grid; place-items: center; border-radius: 50%; color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent); border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 24%, transparent); }
    @media (prefers-reduced-motion: reduce) { .sk-line { animation: none; } }

    /* ─── Live pill ──────────────────────────────────────────────────── */
    .live-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: rgba(16,185,129,0.10); border: 1px solid rgba(16,185,129,0.28); font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em; color: #10b981; }
    .live-pill--paused { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.10); color: rgba(255,255,255,0.55); }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 0 currentColor; animation: livePulse 1.8s ease-out infinite; }
    .live-pill--paused .live-dot { animation: none; opacity: 0.5; }
    @keyframes livePulse { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); } 70% { box-shadow: 0 0 0 6px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }
    @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }
    .live-text { text-transform: uppercase; }

    /* ─── Grid frame: full-bleed inside a soft border ────────────────── */
    .grid-frame {
      width: 100%;
      border: 1px solid color-mix(in oklch, currentColor 12%, transparent);
      border-radius: var(--ps-radius-lg, 14px);
      overflow: hidden;
      background: rgba(0,0,0,0.18);
      box-shadow: var(--ps-shadow-md, 0 4px 12px rgba(0,0,0,0.18));
    }

    /* ─── Period selector (chart) ────────────────────────────────────── */
    .period-pills { display: inline-flex; gap: 4px; padding: 3px; border-radius: 999px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
    .period-pill { padding: 4px 11px; border-radius: 999px; border: 0; background: transparent; color: rgba(255,255,255,0.7); font-size: 0.7rem; font-weight: 600; cursor: pointer; transition: background 140ms ease, color 140ms ease; }
    .period-pill:hover { color: #fff; }
    .period-pill.active { background: linear-gradient(135deg, rgba(0,229,255,0.22), rgba(124,58,237,0.22)); color: #00E5FF; }
    @media (prefers-reduced-motion: reduce) { .period-pill { transition: none; } }
    .chart-svg { display: block; }
    .chart-legend { display: flex; align-items: center; gap: 0.6rem; font-size: 0.65rem; color: rgba(255,255,255,0.65); margin-top: 0.5rem; flex-wrap: wrap; }
    .lg-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 0.4rem; }
    .lg-dot.lg-p50 { background: #00E5FF; }
    .lg-dot.lg-p95 { background: #7C3AED; }
    .lg-dot.lg-p99 { background: #fbbf24; }
    .lg-dot:first-child { margin-left: 0; }

    /* ─── Filter shell: focus ring on wrapper, NOT on input ──────────── */
    .filter-shell {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 7px 12px; border-radius: 10px;
      background: rgba(0,0,0,0.28);
      border: 1px solid rgba(255,255,255,0.08);
      width: min(100%, 480px);
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    .filter-shell.is-focused { border-color: rgba(0,229,255,0.55); box-shadow: 0 0 0 3px rgba(0,229,255,0.16); }
    .filter-icon { color: rgba(255,255,255,0.55); flex: 0 0 auto; }
    /* .filter-input removed — now Spartan hlmInput [seamless] (wrapper owns the pill). */
    .filter-kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.65rem; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.65); }

    /* ─── Toolbar + native table (TanStack headless) ─────────────────── */
    .grid-toolbar {
      display: flex; align-items: center; justify-content: flex-end; gap: 12px;
      padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .page-count { font-size: 0.7rem; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; }
    table.ps-traces-grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.76rem; }
    .ps-traces-grid col.col-status { width: 90px; }
    .ps-traces-grid col.col-when { width: 140px; }
    .ps-traces-grid col.col-endpoint { width: 150px; }
    .ps-traces-grid col.col-tool { width: 140px; }
    .ps-traces-grid col.col-model { width: 120px; }
    .ps-traces-grid col.col-latency { width: 110px; }
    .ps-traces-grid col.col-credits { width: 90px; }
    .ps-traces-grid thead th {
      position: sticky; top: 0; z-index: 1;
      background: #0e0e22; text-align: left; padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: rgba(255,255,255,0.6); font-weight: 700;
    }
    .ps-traces-grid th.th-sortable { cursor: pointer; user-select: none; transition: color 140ms ease; }
    .ps-traces-grid th.th-sortable:hover { color: #00E5FF; }
    .ps-traces-grid th.th-sortable:focus-visible { outline: 2px solid #00E5FF; outline-offset: -2px; }
    .ps-traces-grid th.th-num { text-align: right; }
    .sort-glyph { color: #00E5FF; }
    .ps-traces-grid td {
      padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.04);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
    }
    .master-row { cursor: pointer; transition: background 140ms ease; }
    .master-row:hover { background: rgba(0,229,255,0.06); box-shadow: inset 3px 0 0 rgba(0,229,255,0.35); }
    .master-row.is-expanded { background: rgba(0,229,255,0.03); }
    .cell-mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; }
    .cell-when { color: rgba(255,255,255,0.72); font-variant-numeric: tabular-nums; }
    .cell-num { text-align: right; font-variant-numeric: tabular-nums; }

    /* ─── Cell: status pill ──────────────────────────────────────────── */
    .cell-status-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.5; }
    .cell-status-pill.ok { background: rgba(16,185,129,0.14); color: #34d399; border: 1px solid rgba(16,185,129,0.32); }
    .cell-status-pill.error { background: rgba(239,68,68,0.14); color: #fca5a5; border: 1px solid rgba(239,68,68,0.34); }
    .cell-status-pill.rate { background: rgba(251,191,36,0.14); color: #fcd34d; border: 1px solid rgba(251,191,36,0.32); }
    .cell-status-pill.timeout { background: rgba(168,85,247,0.14); color: #d8b4fe; border: 1px solid rgba(168,85,247,0.32); }
    .cell-status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

    /* ─── Cell: latency w/ proportional fill ─────────────────────────── */
    .latency-cell { position: relative; display: flex; align-items: center; justify-content: flex-end; height: 100%; padding-right: 8px; }
    .latency-cell .lat-fill { position: absolute; left: 4px; top: 50%; transform: translateY(-50%); height: 18px; border-radius: 4px; opacity: 0.20; pointer-events: none; }
    .latency-cell .lat-fill.good { background: linear-gradient(90deg, rgba(16,185,129,0.4), rgba(16,185,129,0.08)); }
    .latency-cell .lat-fill.mid  { background: linear-gradient(90deg, rgba(251,191,36,0.55), rgba(251,191,36,0.08)); }
    .latency-cell .lat-fill.bad  { background: linear-gradient(90deg, rgba(239,68,68,0.65), rgba(239,68,68,0.08)); }
    .latency-cell .lat-val { position: relative; z-index: 1; font-variant-numeric: tabular-nums; font-weight: 600; color: rgba(255,255,255,0.92); }

    /* ─── Detail panel: master/detail expansion (cinematic) ──────────── */
    .detail-row td { padding: 0; border-bottom: 1px solid rgba(0,229,255,0.10); white-space: normal; overflow: visible; }
    .detail-card {
      position: relative; padding: 1.1rem 1.3rem 1.35rem; margin: 0;
      background:
        radial-gradient(120% 80% at 50% -20%, rgba(0,229,255,0.10), transparent 60%),
        linear-gradient(180deg, rgba(0,229,255,0.05) 0%, rgba(124,58,237,0.03) 55%, rgba(6,6,16,0.0) 100%),
        rgba(6,6,16,0.55);
      border-radius: var(--ps-radius-lg, 14px);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.06),
        inset 0 -1px 0 rgba(0,0,0,0.35),
        0 0 80px rgba(0, 229, 255, 0.04);
      animation: detail-in 320ms var(--ps-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1));
      transform-origin: top center; overflow: hidden;
    }
    .detail-card::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(0,229,255,0.55) 22%, rgba(124,58,237,0.45) 64%, transparent);
      pointer-events: none;
    }
    @keyframes detail-in {
      0%   { opacity: 0; transform: translateY(-8px) scaleY(0.96); filter: blur(2px); }
      60%  { opacity: 1; filter: blur(0); }
      100% { opacity: 1; transform: translateY(0) scaleY(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .detail-card { animation: none; }
    }

    /* Metric pill header — latency / cost / tokens / model along the top. */
    .detail-card .det-meta {
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      margin: 0 0 0.85rem;
    }
    .detail-card .met-pill {
      display: inline-flex; align-items: baseline; gap: 6px;
      padding: 4px 11px 4px 9px; border-radius: 999px;
      font: 700 0.6rem/1 'JetBrains Mono', ui-monospace, monospace;
      letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--mpill, #00E5FF);
      background: color-mix(in oklch, var(--mpill, #00E5FF) 8%, transparent);
      border: 1px solid color-mix(in oklch, var(--mpill, #00E5FF) 32%, transparent);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
      white-space: nowrap;
    }
    .detail-card .met-pill .met-val {
      font-size: 0.78rem; font-weight: 800; letter-spacing: -0.01em;
      color: #fff; font-variant-numeric: tabular-nums; text-transform: none;
    }
    .detail-card .met-pill.is-lat   { --mpill: #00E5FF; }
    .detail-card .met-pill.is-cost  { --mpill: #fbbf24; }
    .detail-card .met-pill.is-tok   { --mpill: #c4b5fd; }
    .detail-card .met-pill.is-model { --mpill: #34d399; }
    .detail-card .met-pill.is-tool  { --mpill: #fdba74; }

    .detail-card .detail-grid { display: grid; gap: 0.85rem; }
    .detail-card .det-block {
      display: flex; flex-direction: column; gap: 0.45rem;
      position: relative;
      padding: 0.7rem 0.85rem 0.85rem 1rem;
      border-radius: var(--ps-radius-md, 12px);
      background: rgba(255,255,255,0.022);
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
      transition: border-color 220ms var(--ps-ease-emphasized, cubic-bezier(0.16,1,0.3,1));
    }
    .detail-card .det-block::before {
      content: ""; position: absolute; left: 0; top: 14px; bottom: 14px;
      width: 2px; border-radius: 0 2px 2px 0;
      background: var(--det-rail, linear-gradient(180deg, #00E5FF, transparent));
      opacity: 0.7;
    }
    .detail-card .det-block.kind-prompt  { --det-rail: linear-gradient(180deg, #00E5FF, rgba(0,229,255,0)); }
    .detail-card .det-block.kind-input   { --det-rail: linear-gradient(180deg, #7C3AED, rgba(124,58,237,0)); }
    .detail-card .det-block.kind-output  { --det-rail: linear-gradient(180deg, #34d399, rgba(52,211,153,0)); }
    .detail-card .det-block.kind-tool    { --det-rail: linear-gradient(180deg, #f97316, rgba(249,115,22,0)); }
    .detail-card .det-block.kind-error   { --det-rail: linear-gradient(180deg, #ef4444, rgba(239,68,68,0)); }
    .detail-card .det-block.kind-explain { --det-rail: linear-gradient(180deg, #c4b5fd, rgba(196,181,253,0)); }
    .detail-card .det-block:hover { border-color: rgba(0,229,255,0.18); }

    .detail-card .det-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .detail-card .det-label {
      font: 700 0.6rem/1 'JetBrains Mono', ui-monospace, monospace;
      text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.65);
      display: inline-flex; align-items: center; gap: 6px;
    }
    .detail-card .det-block.kind-prompt  .det-label { color: #7feef9; }
    .detail-card .det-block.kind-input   .det-label { color: #c4b5fd; }
    .detail-card .det-block.kind-output  .det-label { color: #6ee7b7; }
    .detail-card .det-block.kind-tool    .det-label { color: #fdba74; }
    .detail-card .det-block.kind-error   .det-label { color: #fca5a5; }
    .detail-card .det-block.kind-explain .det-label { color: #c4b5fd; }

    /* Copy chip per code block */
    .detail-card .det-copy {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 6px;
      font: 700 0.56rem/1 'JetBrains Mono', monospace; letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.55);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      cursor: pointer; opacity: 0;
      transition: opacity 180ms ease, background 140ms ease, color 140ms ease, transform 140ms ease, border-color 140ms ease;
    }
    .detail-card .det-block:hover .det-copy, .detail-card .det-copy:focus-visible { opacity: 1; }
    .detail-card .det-copy:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    .detail-card .det-copy:hover {
      background: rgba(0,229,255,0.10); color: #00E5FF; border-color: rgba(0,229,255,0.30);
      transform: translateY(-1px);
    }
    .detail-card .det-copy.is-copied {
      color: #34d399; border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.10); opacity: 1;
    }

    .detail-card pre {
      background: linear-gradient(180deg, rgba(0,0,0,0.42), rgba(0,0,0,0.55));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-sm, 8px);
      padding: 0.78rem 0.95rem;
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.7rem; line-height: 1.6;
      white-space: pre-wrap; word-break: break-word;
      max-height: 280px; overflow: auto; margin: 0;
      color: rgba(245,245,247,0.94);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .detail-card pre.error-pre {
      border-left: 3px solid #ef4444; color: #fcd34d;
      background: linear-gradient(180deg, rgba(239,68,68,0.10), rgba(239,68,68,0.04));
      border-color: rgba(239,68,68,0.32);
    }
    .detail-card .det-value { font-size: 0.74rem; color: rgba(245,245,247,0.92); word-break: break-word; line-height: 1.45; }
    .detail-card .det-value.dim-italic { opacity: 0.6; font-style: italic; }
    .detail-card .tk-key  { color: #fbbf24; }
    .detail-card .tk-str  { color: #86efac; }
    .detail-card .tk-num  { color: #67e8f9; }
    .detail-card .tk-bool { color: #c4b5fd; }
    .detail-card .tk-null { color: rgba(255,255,255,0.45); }
    .detail-card .tk-pun  { color: rgba(255,255,255,0.55); }
    .detail-card .kw {
      color: #00E5FF; font-weight: 700;
      text-shadow: 0 0 12px rgba(0,229,255,0.35);
    }

    .detail-card .det-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 0.4rem; }
    .detail-card .det-action {
      position: relative; isolation: isolate;
      padding: 0.55rem 1rem; border-radius: var(--ps-radius-sm, 8px);
      font: 700 0.68rem/1 'Sora', system-ui, sans-serif; letter-spacing: 0.02em;
      cursor: pointer; border: 1px solid transparent;
      background:
        linear-gradient(rgba(6,6,16,0.78), rgba(6,6,16,0.78)) padding-box,
        linear-gradient(135deg, rgba(0,229,255,0.55), rgba(124,58,237,0.42)) border-box;
      color: #7feef9;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
      transition:
        transform 140ms var(--ps-ease-emphasized, cubic-bezier(0.16,1,0.3,1)),
        box-shadow 220ms ease, background 200ms ease, color 140ms ease;
    }
    .detail-card .det-action:hover:not([disabled]) {
      transform: translateY(-2px); color: #ccfafd;
      box-shadow:
        0 8px 22px -8px rgba(0, 229, 255, 0.55),
        inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .detail-card .det-action:active:not([disabled]) {
      transform: translateY(0) scale(0.97); transition-duration: 80ms;
      box-shadow: 0 0 0 4px rgba(0,229,255,0.22);
    }
    .detail-card .det-action[disabled] { opacity: 0.40; cursor: not-allowed; }
    .detail-card .det-action.violet {
      background:
        linear-gradient(rgba(6,6,16,0.78), rgba(6,6,16,0.78)) padding-box,
        linear-gradient(135deg, rgba(124,58,237,0.65), rgba(0,229,255,0.42)) border-box;
      color: #c4b5fd;
    }
    .detail-card .det-action.violet:hover:not([disabled]) {
      color: #ddd6fe;
      box-shadow:
        0 8px 22px -8px rgba(124, 58, 237, 0.55),
        inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .detail-card .det-action.ghost {
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.74);
    }
    .detail-card .det-action.ghost:hover:not([disabled]) {
      background: rgba(255,255,255,0.05); color: #fff;
      border-color: rgba(255,255,255,0.22);
    }
    .detail-card .det-action:focus-visible {
      outline: 2px solid #00E5FF; outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .detail-card .det-action { transition: none; }
      .detail-card .det-action:hover:not([disabled]) { transform: none; }
    }

    .detail-card .det-explain {
      margin-top: 0; padding: 0.85rem 1rem; border-radius: var(--ps-radius-sm, 8px);
      background: linear-gradient(135deg, rgba(124,58,237,0.14), rgba(124,58,237,0.06));
      border: 1px solid rgba(124,58,237,0.35);
      color: rgba(245,245,247,0.94); font-size: 0.74rem; line-height: 1.6;
      white-space: pre-wrap;
      box-shadow: inset 0 1px 0 rgba(196,181,253,0.10);
    }

    /* ─── Footer (pagination) ────────────────────────────────────────── */
    .grid-footer {
      display: flex; align-items: center; justify-content: flex-end; gap: 12px;
      padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.06);
    }
    .page-size-label { display: inline-flex; }
    .page-indicator { font-size: 0.72rem; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
    .pager-btns { display: flex; gap: 6px; }
    .site-select {
      background: #0d0d1f; color: #e5e7eb;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      padding: 6px 10px; font-size: 0.72rem; font-family: inherit; cursor: pointer;
    }
    .site-select:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    .filtered-empty-row td { padding: 0; white-space: normal; }
    .filtered-empty { padding: 28px 14px; text-align: center; font-size: 0.76rem; color: rgba(255,255,255,0.55); }
  `],
})
export class AdminAiLogsComponent implements OnInit, OnDestroy {
  state = inject(AdminStateService);
  private api = inject(ApiService);
  private router = inject(Router);
  private toast = inject(ToastService);

  @ViewChild('filterInput') filterInputRef?: ElementRef<HTMLInputElement>;

  /** Raw trace rows from the API. Drives every derived signal below. */
  rows = signal<TraceRow[]>([]);
  /** Raw `meta.total` from the last load (a worker COUNT); 0 when unknown. */
  private readonly metaTotal = signal(0);
  /** TRUE site-wide AI-call count from the worker (independent of the page cap).
   *  Falls back to the loaded length for an older worker w/o meta; never fewer than
   *  what's on screen. */
  readonly totalCount = computed(() => Math.max(this.metaTotal(), this.rows().length));
  /** True when the store holds more calls than the loaded page — drives the honest
   *  "showing latest N of M calls" note so the window's stats aren't mistaken for totals. */
  readonly hasHiddenCalls = computed(() => this.totalCount() > this.rows().length);
  loading = signal(false);
  /** Persistent load failure — shown only when there are no rows (so a failed fetch isn't a blank/empty masquerade); stale data stays visible otherwise. */
  loadError = signal<string | null>(null);
  /** Consecutive failed auto-polls. After MAX, the 15s poll PAUSES so it stops
   *  re-hammering a persistently-failing endpoint ([[error-recovery]] "retry
   *  with backoff, max 3"). Manual Retry (+ tab-return) bypasses the guard and a
   *  successful load resets the counter → auto-poll resumes. */
  private static readonly MAX_AUTO_RETRIES = 3;
  readonly consecutiveErrors = signal(0);
  readonly autoRefreshPaused = computed(() => this.consecutiveErrors() >= AdminAiLogsComponent.MAX_AUTO_RETRIES);
  filter = signal('');
  searchFocused = signal(false);
  polling = signal(true);

  /** Set of trace ids currently expanded in the table. */
  readonly expandedIds = signal<Set<string>>(new Set<string>());
  /** Cache of fetched details keyed by trace id (lazy-loaded on expand). */
  private detailCache = signal<Map<string, TraceDetail>>(new Map());
  /** Cache of AI explanations keyed by trace id. */
  private explainCache = signal<Map<string, string>>(new Map());
  /** Per-row explain-in-flight flag, for spinner UI. */
  private explainLoading = signal<Set<string>>(new Set());

  chartPeriod = signal<ChartPeriod>('24h');

  periods: ReadonlyArray<{ id: ChartPeriod; label: string; ms: number }> = [
    { id: '1h',  label: '1h',  ms: 60 * 60 * 1000 },
    { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
    { id: '7d',  label: '7d',  ms: 7 * 24 * 60 * 60 * 1000 },
    { id: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  ] as const;

  /** Number of evenly-spaced time bins for the latency-percentile chart. */
  private static readonly CHART_BINS = 24;

  // ─── KPI signals ────────────────────────────────────────────────────
  avgLatency = computed<number>(() => {
    const list = this.rows();
    if (!list.length) return 0;
    return Math.round(list.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / list.length);
  });
  errors = computed<number>(() => this.rows().filter((r) => r.status === 'error').length);
  totalCredits = computed<number>(() => this.rows().reduce((a, r) => a + (r.credits_debited ?? 0), 0));
  /** Initial fetch with nothing yet on screen → show a skeleton, not a bare empty table. */
  gridLoadingSkeleton = computed<boolean>(() => this.loading() && this.rows().length === 0);
  /** Genuine "no traces yet" (not loading, no error) → a friendly empty state. */
  gridEmpty = computed<boolean>(() => !this.loading() && !this.loadError() && this.rows().length === 0);
  /** KPI tiles hidden when the load errored with no data — a definitive "0 calls
   *  · 0ms · 0 errors · 0 credits" over the error card is wrong (unknown, not 0). */
  showKpis = computed<boolean>(
    () => !this.gridLoadingSkeleton() && (!this.loadError() || this.rows().length > 0),
  );

  // ── TanStack headless table (quick-filter pre-filter + sort + pagination) ──

  /** Human header labels keyed by column id (template reads these). */
  readonly headerLabel: Record<string, string> = {
    status: 'Status',
    created_at: 'When',
    endpoint_slug: 'Endpoint',
    tool_name: 'Tool',
    model: 'Model',
    latency_ms: 'Latency',
    credits_debited: 'Credits',
    actor_email: 'Actor',
  };
  /** Column count for the detail row's colspan + the filtered-empty row. */
  readonly columnCount = 8;
  /** Page-size options — mirrors the old ag-grid selector. */
  readonly pageSizeOptions = [25, 50, 100, 250] as const;
  /** Sortable column ids — the col-state restore validates against this set. */
  private static readonly SORT_IDS = ['status', 'created_at', 'endpoint_slug', 'tool_name', 'model', 'latency_ms', 'credits_debited', 'actor_email'] as const;
  /** localStorage key for the persisted table state (sort) — key reused from
   *  the ag-grid era; the old column-state shape fails validation and is
   *  silently ignored. */
  private static readonly COL_STATE_KEY = 'ps_traces_grid_v1';

  /** Restore a valid sorting state from localStorage; `[]` when absent/corrupt. */
  private static restoreSort(): SortingState {
    try {
      const raw = localStorage.getItem(AdminAiLogsComponent.COL_STATE_KEY);
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
          (AdminAiLogsComponent.SORT_IDS as readonly string[]).includes(s.id) &&
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
    const restored = AdminAiLogsComponent.restoreSort();
    return restored.length > 0 ? restored : [{ id: 'created_at', desc: true }];
  }

  readonly sorting = signal<SortingState>(AdminAiLogsComponent.defaultSort());
  /** Pagination state — pageSize 50 default (old ag-grid parity). */
  readonly pagination = signal<PaginationState>({ pageIndex: 0, pageSize: 50 });

  private readonly columns: ColumnDef<TraceRow>[] = [
    { id: 'status', accessorKey: 'status' },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      // ISO-8601 strings sort lexicographically = chronologically, but older
      // rows may carry other formats — Date.parse comparator keeps parity
      // with the old ag-grid date comparator.
      sortingFn: (rowA, rowB) =>
        Date.parse(String(rowA.original.created_at ?? 0)) - Date.parse(String(rowB.original.created_at ?? 0)),
    },
    { id: 'endpoint_slug', accessorKey: 'endpoint_slug' },
    { id: 'tool_name', accessorKey: 'tool_name' },
    { id: 'model', accessorKey: 'model' },
    { id: 'latency_ms', accessorKey: 'latency_ms' },
    { id: 'credits_debited', accessorKey: 'credits_debited' },
    { id: 'actor_email', accessorKey: 'actor_email' },
  ];

  /** Rows surviving the free-text quick-filter (endpoint/tool/model/actor/
   *  preview/error/trace-kind haystack). Feeds the table directly. */
  readonly filteredRows = computed<TraceRow[]>(() => {
    const q = this.filter().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter((r) => {
      const hay = `${r.endpoint_slug ?? ''} ${r.tool_name ?? ''} ${r.model ?? ''} ${r.actor_email ?? ''} ${r.output_preview ?? ''} ${r.error_message ?? ''} ${r.trace_kind}`.toLowerCase();
      return hay.includes(q);
    });
  });

  readonly table = createAngularTable<TraceRow>(() => ({
    data: this.filteredRows(),
    columns: this.columns,
    state: {
      sorting: this.sorting(),
      pagination: this.pagination(),
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(this.sorting()) : updater;
      this.sorting.set(next);
      this.persistColState();
    },
    onPaginationChange: (updater) =>
      this.pagination.set(typeof updater === 'function' ? updater(this.pagination()) : updater),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  }));

  /** Rows surviving the quick-filter (independent of pagination). */
  readonly filteredCount = computed(() => this.table.getFilteredRowModel().rows.length);

  constructor() {
    // Clamp a stale pageIndex after a poll/filter shrinks the row set —
    // TanStack leaves an empty page where ag-grid silently re-rewound.
    effect(() => {
      if (this.table.getFilteredRowModel().rows.length === 0) return;
      const pageCount = this.table.getPageCount();
      const pageIndex = this.table.getState().pagination.pageIndex;
      if (pageIndex >= pageCount) {
        this.table.setPageIndex(pageCount - 1);
      }
    });
  }

  /** Persist the sort state under `ps_traces_grid_v1` (`{sorting:[…]}` shape). */
  private persistColState(): void {
    try {
      localStorage.setItem(
        AdminAiLogsComponent.COL_STATE_KEY,
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

  // ─── Chart: derive p50/p95/p99 from currently-loaded rows ──────────
  /**
   * Bin trace rows into N equal-width time slots over the selected period
   * and compute the latency p50/p95/p99 per bin. Bins with no samples
   * report 0 — the area chart will draw them as ground level.
   */
  chartBins = computed<{ p50: number; p95: number; p99: number; count: number }[]>(() => {
    const period = this.periods.find((p) => p.id === this.chartPeriod()) ?? this.periods[1]!;
    const now = Date.now();
    const from = now - period.ms;
    const bins = AdminAiLogsComponent.CHART_BINS;
    const binMs = period.ms / bins;
    const buckets: number[][] = Array.from({ length: bins }, () => []);
    for (const r of this.rows()) {
      const t = Date.parse(r.created_at);
      if (!Number.isFinite(t) || t < from || t > now) continue;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((t - from) / binMs)));
      if (r.latency_ms != null) buckets[idx]!.push(r.latency_ms);
    }
    return buckets.map((arr) => {
      if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };
      const sorted = [...arr].sort((a, b) => a - b);
      const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), count: arr.length };
    });
  });

  /**
   * Loaded traces that actually fall inside the selected window — surfaced in
   * the chart subtitle so a sparse long-period view (only the recent N traces
   * are fetched, no server-side window param) reads as "small sample", not
   * "no activity".
   */
  readonly windowSampleCount = computed<number>(() =>
    this.chartBins().reduce((sum, b) => sum + b.count, 0),
  );

  /** Maximum latency across all percentiles in the current chart window. */
  private chartMax = computed<number>(() => {
    const bins = this.chartBins();
    return Math.max(1, ...bins.map((b) => b.p99));
  });

  /** Overall percentile across the currently-loaded rows (chart subtitle). */
  currentP(q: number): number {
    const lat = this.rows().map((r) => r.latency_ms ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
    if (!lat.length) return 0;
    return lat[Math.min(lat.length - 1, Math.floor((q / 100) * lat.length))] ?? 0;
  }

  /** SVG path `d` for a percentile band's filled area (with gradient). */
  chartAreaPath(key: 'p50' | 'p95' | 'p99'): string {
    const bins = this.chartBins();
    if (!bins.length) return '';
    const max = this.chartMax();
    const w = 600;
    const h = 140;
    const step = bins.length > 1 ? w / (bins.length - 1) : 0;
    const pts = bins.map((b, i) => ({
      x: i * step,
      y: h - 6 - (b[key] / max) * (h - 16),
    }));
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    return `${line} L ${pts[pts.length - 1]!.x.toFixed(1)} ${h} L ${pts[0]!.x.toFixed(1)} ${h} Z`;
  }

  /** SVG path `d` for the percentile line (stroked overlay on top of area). */
  chartLinePath(key: 'p50' | 'p95' | 'p99'): string {
    const bins = this.chartBins();
    if (!bins.length) return '';
    const max = this.chartMax();
    const w = 600;
    const h = 140;
    const step = bins.length > 1 ? w / (bins.length - 1) : 0;
    return bins.map((b, i) => {
      const x = i * step;
      const y = h - 6 - (b[key] / max) * (h - 16);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }

  chartPeriodLabel = computed<string>(() => {
    const p = this.periods.find((x) => x.id === this.chartPeriod());
    if (!p) return '';
    switch (p.id) {
      case '1h':  return 'the past hour';
      case '24h': return 'the past 24 hours';
      case '7d':  return 'the past 7 days';
      case '30d': return 'the past 30 days';
      default:    return '';
    }
  });

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler?: () => void;
  /** Polling cadence — 15s matches the audit grid and the spec. */
  private static readonly POLL_MS = 15_000;

  ngOnInit(): void {
    this.reload();
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        this.polling.set(false);
        return;
      }
      if (this.autoRefreshPaused()) { this.polling.set(false); return; } // stopped after repeated errors; Retry/tab-return resumes
      this.polling.set(true);
      this.reload();
    }, AdminAiLogsComponent.POLL_MS);
    this.visibilityHandler = (): void => {
      if (typeof document === 'undefined') return;
      const vis = document.visibilityState === 'visible';
      this.polling.set(vis);
      if (vis) this.reload();
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

  reload(): void {
    const s = this.state.selectedSite();
    if (!s) return;
    this.loading.set(true);
    this.api.get<{ data: TraceRow[]; meta?: { total?: number; has_more?: boolean } }>(`/sites/${s.id}/ai-logs`, undefined, { silent: true }).subscribe({
      next: (r) => { this.rows.set(r.data ?? []); this.metaTotal.set(r.meta?.total ?? 0); this.loadError.set(null); this.loading.set(false); this.consecutiveErrors.set(0); },
      // Silent error → empty table masquerades as "no traces". Record it; the
      // banner shows only when there are no rows (stale data stays visible on a poll blip).
      error: () => { this.loadError.set('Could not load AI traces — retry.'); this.loading.set(false); this.consecutiveErrors.update((n) => n + 1); },
    });
  }

  /**
   * Toggle the expanded state for a trace row — the detail `<tr>` renders
   * directly below the master via `expandedIds` + `@if`. First expand
   * lazy-fetches the full trace detail.
   */
  toggleExpand(row: TraceRow): void {
    const next = new Set(this.expandedIds());
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    this.expandedIds.set(next);
    if (next.has(row.id)) this.fetchDetail(row.id);
  }

  /**
   * Click anywhere on a master row to toggle its accordion. Cells mid
   * text-selection and actionable children (links, buttons) keep the click.
   */
  onRowClick(ev: Event, row: TraceRow): void {
    // If the user is mid-selection (range-drag on cell text), don't toggle.
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    // If the click landed on an actionable child (link, button), let it own the click.
    const target = ev.target as HTMLElement | undefined;
    if (target?.closest('a, button')) return;
    this.toggleExpand(row);
  }

  /** Lazy-fetch the full trace detail on first expand. */
  private fetchDetail(id: string): void {
    if (this.detailCache().has(id)) return;
    const s = this.state.selectedSite();
    if (!s) return;
    this.api.get<{ data: TraceDetail }>(`/sites/${s.id}/ai-logs/${id}`).subscribe({
      next: (r) => {
        const next = new Map(this.detailCache());
        next.set(id, r.data);
        this.detailCache.set(next);
      },
      error: () => { /* api.service already toasts */ },
    });
  }

  /** Copy the full trace (header + detail) to the clipboard as JSON. */
  async copyTrace(detail: TraceDetail): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(detail, null, 2));
      this.toast.success('Trace copied to clipboard');
    } catch {
      this.toast.error('Clipboard unavailable');
    }
  }

  /**
   * Code-block copy chip — writes `src` and flips the button to a "Copied"
   * visual for 1.2s (same UX as the imperative ag-grid renderer).
   */
  copyChip(ev: Event, src: string): void {
    const btn = ev.currentTarget as HTMLButtonElement | null;
    if (!btn || !src) return;
    void navigator.clipboard.writeText(src).then(
      () => {
        const original = btn.textContent ?? 'Copy';
        btn.classList.add('is-copied');
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.classList.remove('is-copied');
          btn.textContent = original;
        }, 1200);
      },
      () => this.toast.error('Clipboard unavailable'),
    );
  }

  /**
   * POST to the explain endpoint. If the API returns 404/501 (not yet wired
   * up), surface a friendly toast and stub a cached message so the panel
   * still renders something useful.
   */
  explainTrace(id: string): void {
    if (this.explainCache().has(id) || this.explainLoading().has(id)) return;
    const loading = new Set(this.explainLoading());
    loading.add(id);
    this.explainLoading.set(loading);
    this.api.post<{ data: { markdown: string; model?: string; cached?: boolean } }>(
      `/admin/traces/${id}/explain`, {}, { silent: true },
    ).subscribe({
      next: (r) => {
        const next = new Map(this.explainCache());
        next.set(id, r?.data?.markdown ?? 'Explanation returned empty.');
        this.explainCache.set(next);
        const l = new Set(this.explainLoading()); l.delete(id); this.explainLoading.set(l);
      },
      error: (err: unknown) => {
        const code = (err as { status?: number } | null)?.status;
        const l = new Set(this.explainLoading()); l.delete(id); this.explainLoading.set(l);
        // The explain backend (/api/admin/traces/:id/explain) is live; a 404
        // means the trace row is gone (pruned), not "feature not shipped".
        const next = new Map(this.explainCache());
        if (code === 404) {
          this.toast.error('Trace not found — it may have been pruned.');
          next.set(id, 'This trace is no longer available.');
        } else {
          this.toast.error('Could not load explanation. Try again.');
          next.set(id, 'Explanation failed to load — retry.');
        }
        this.explainCache.set(next);
      },
    });
  }

  // ─── Hotkeys: `/` focuses the filter input (mirrors sidebar pattern) ─
  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    if (ev.key === '/') {
      ev.preventDefault();
      this.filterInputRef?.nativeElement.focus();
    }
  }

  // ─── Template helpers ───────────────────────────────────────────────
  asInputValue(ev: Event): string {
    const el = ev.target as HTMLInputElement | null;
    return el?.value ?? '';
  }
  formatNumber(n: number): string { return NUMBER_FORMATTER.format(n); }
  formatLatencyMs(ms: number): string { return formatLatency(ms); }

  relTime(iso: string | null | undefined): string {
    return relativeTime(iso);
  }

  isoOf(v: string | null | undefined): string {
    if (!v) return '';
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
  }

  statusPillClass(r: TraceRow): string {
    const v = (r.status ?? '').toLowerCase();
    if (v === 'error') return 'error';
    if (v === 'rate_limited' || v === 'rate-limited') return 'rate';
    if (v === 'timeout') return 'timeout';
    return 'ok';
  }

  statusLabel(r: TraceRow): string {
    const v = r.status ?? '';
    return v ? v.replace(/_/g, ' ') : '—';
  }

  endpointLabel(r: TraceRow): string {
    return r.endpoint_slug ?? r.trace_kind ?? '—';
  }

  prettyModel(slug: string | null | undefined): string {
    return prettifyModel(slug);
  }

  fmtLatency(ms: number | null | undefined): string {
    return formatLatency(ms);
  }

  latBandOf(r: TraceRow): string {
    return latencyBand(r.latency_ms);
  }

  /** Proportional fill width for the latency cell (clamped 0-100% of a 2s axis). */
  latFillWidth(r: TraceRow): string {
    const pct = Math.max(0, Math.min(100, ((r.latency_ms ?? 0) / 2000) * 100));
    return `calc(${pct.toFixed(1)}% - 8px)`;
  }

  creditsLabel(r: TraceRow): string {
    return NUMBER_FORMATTER.format(r.credits_debited ?? 0);
  }

  actorLabel(r: TraceRow): string {
    return fallbackActor(r);
  }

  actorTitleOf(r: TraceRow): string {
    return r.actor_email ?? r.user_id ?? '—';
  }

  /** Total in+out tokens for a detail row (meta pill). */
  tokensOf(d: TraceDetail): number {
    return (d.tokens_input ?? 0) + (d.tokens_output ?? 0);
  }

  /** Cached full detail for a trace id; undefined while loading/failed. */
  detailFor(id: string): TraceDetail | undefined {
    return this.detailCache().get(id);
  }

  /** Cached AI explanation for a trace id. */
  explainFor(id: string): string | undefined {
    return this.explainCache().get(id);
  }

  /** Whether an explain request is in flight for this trace id. */
  explainingFor(id: string): boolean {
    return this.explainLoading().has(id);
  }

  /** The output body: text first, then JSON; '' when neither was captured. */
  outputText(d: TraceDetail): string {
    return d.output_text ?? d.output_json ?? '';
  }

  /** Pretty-print a captured JSON string (identity fallback on non-JSON). */
  prettyJson(raw: string | null | undefined): string {
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); }
    catch { return raw; }
  }

  /** HTML-highlighted system prompt (template binds via [innerHTML]). */
  promptHtml(src: string | null | undefined): string {
    return src ? highlightSystemPrompt(src) : '';
  }

  /** HTML-highlighted JSON (template binds via [innerHTML]). */
  highlightJson(src: string): string {
    return highlightJson(src);
  }
}
