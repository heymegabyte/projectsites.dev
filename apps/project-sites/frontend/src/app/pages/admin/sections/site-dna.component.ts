/**
 * /admin/sites/:id/dna — Site DNA Taste Graph admin panel.
 *
 * Shows:
 *   - Stats row (total feedback, accepted, rejected, edited) via <app-rolling-counter>
 *   - Feedback history table (≤36px rows, newest-first, paginated 50)
 *   - Preferences chart — top accepted component classes as a horizontal bar grid
 *   - Manual feedback submission form (component_id + action + optional context JSON)
 *
 * Flag: `site_dna_taste_graph` (experimental, enabled=0, rollout=0).
 * Renders a flag-gate notice when off.
 * All numerics via <app-rolling-counter>, sections via appReveal directive.
 */

import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  Input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ApiService } from '../../../services/api.service';
import { FeatureFlagService } from '../../../services/feature-flag.service';
import { Subject, takeUntil, forkJoin } from 'rxjs';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { FlagGateNoticeComponent } from '../../../components/states/flag-gate-notice.component';
import { ErrorCardComponent } from '../../../components/states';
import { HlmInputDirective, HlmSelectDirective } from '../../../ui';
import { RevealDirective } from '../../../directives/reveal.directive';

// ── Data shapes (mirrors site_dna.ts service types) ──────────────────────

interface DnaFeedbackRow {
  id: string;
  component_id: string;
  component_class: string;
  action: 'accept' | 'reject' | 'edit';
  context: Record<string, unknown> | null;
  created_at: string;
}

interface DnaPrefRow {
  component_class: string;
  accept_count: number;
  reject_count: number;
  net_score: number;
}

interface DnaHistoryResp {
  site_id: string;
  history: DnaFeedbackRow[];
  count: number;
}

interface DnaPrefsResp {
  site_id: string;
  component_class: string;
  preferences: DnaPrefRow[];
  count: number;
}

// ── Component ─────────────────────────────────────────────────────────────

@Component({
  selector: 'app-admin-site-dna',
  standalone: true,
  imports: [RevealDirective, CommonModule, FormsModule, RouterModule, RollingCounterComponent, HlmInputDirective, HlmSelectDirective, FlagGateNoticeComponent, ErrorCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dna-shell" appReveal>

      <!-- Header -->
      <header class="dna-hdr">
        <div>
          <span class="dna-eyebrow">Site DNA</span>
          <h2 class="dna-title">Taste Graph</h2>
          <p class="dna-sub">
            Accept/reject/edit signals per component — shapes the AI's style preferences over time.
          </p>
        </div>
        <a routerLink="/admin/feature-flags" class="dna-flag-link" title="Manage flags">
          <code class="dna-flag-chip">site_dna_taste_graph</code>
        </a>
      </header>

      <!-- Flag-gate notice -->
      @if (!flagEnabled()) {
        <app-flag-gate-notice feature="The Site DNA Taste Graph" flag="site_dna_taste_graph" testid="dna-flag-gate" />
      } @else {

        <!-- Stats row — labels stay mounted; numbers shimmer until the first
             fetch resolves so a definitive "0 signals" never flashes over the
             still-loading table below (premature-stat-during-load guard). -->
        <!-- Stats hidden when the load errored with no data — a definitive
             "0 signals · 0 accepted · …" over the error message is wrong (the
             count is unknown, not 0). Mirrors the marketplace stat-over-error fix. -->
        @if (!loadError() || totalFeedback() > 0) {
        <div class="dna-stats" appReveal data-testid="dna-stats" [attr.aria-busy]="showStatsSkeleton()">
          <div class="dna-stat">
            @if (showStatsSkeleton()) {
              <span class="glow-skel dna-stat-skel" aria-hidden="true"></span>
            } @else {
              <app-rolling-counter [value]="totalFeedback()" suffix=" signals" />
            }
            <span class="dna-stat-label">Total</span>
          </div>
          <div class="dna-stat">
            @if (showStatsSkeleton()) {
              <span class="glow-skel dna-stat-skel" aria-hidden="true"></span>
            } @else {
              <app-rolling-counter [value]="acceptCount()" suffix=" accepted" />
            }
            <span class="dna-stat-label dna-stat-label--accept"><span class="dna-glyph" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span> Accepted</span>
          </div>
          <div class="dna-stat">
            @if (showStatsSkeleton()) {
              <span class="glow-skel dna-stat-skel" aria-hidden="true"></span>
            } @else {
              <app-rolling-counter [value]="rejectCount()" suffix=" rejected" />
            }
            <span class="dna-stat-label dna-stat-label--reject"><span class="dna-glyph" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span> Rejected</span>
          </div>
          <div class="dna-stat">
            @if (showStatsSkeleton()) {
              <span class="glow-skel dna-stat-skel" aria-hidden="true"></span>
            } @else {
              <app-rolling-counter [value]="editCount()" suffix=" edited" />
            }
            <span class="dna-stat-label dna-stat-label--edit"><span class="dna-glyph" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></span> Edited</span>
          </div>
          <div class="dna-stat">
            @if (showStatsSkeleton()) {
              <span class="glow-skel dna-stat-skel" aria-hidden="true"></span>
            } @else {
              <app-rolling-counter [value]="prefCount()" suffix=" classes" />
            }
            <span class="dna-stat-label">Learned</span>
          </div>
        </div>
        }

        <!-- Taste Pulse — segmented distribution of accept/reject/edit signals.
             Cyan-forward "what the AI has learned to favor" at a glance. -->
        @if (totalFeedback() > 0) {
          <div class="dna-pulse" appReveal data-testid="dna-taste-pulse">
            <div class="dna-pulse-hdr">
              <span class="dna-section-label">Taste pulse</span>
              <span class="dna-pulse-ratio" aria-hidden="true">{{ acceptRatio() }}% accept rate</span>
            </div>
            <div
              class="dna-pulse-bar"
              role="img"
              [attr.aria-label]="pulseAriaLabel()"
            >
              @if (acceptCount() > 0) {
                <span class="dna-pulse-seg dna-pulse-seg--accept" [style.width]="segPct(acceptCount()) + '%'" title="Accepted"></span>
              }
              @if (editCount() > 0) {
                <span class="dna-pulse-seg dna-pulse-seg--edit" [style.width]="segPct(editCount()) + '%'" title="Edited"></span>
              }
              @if (rejectCount() > 0) {
                <span class="dna-pulse-seg dna-pulse-seg--reject" [style.width]="segPct(rejectCount()) + '%'" title="Rejected"></span>
              }
            </div>
            <div class="dna-pulse-legend" aria-hidden="true">
              <span class="dna-pulse-key dna-pulse-key--accept">Accept</span>
              <span class="dna-pulse-key dna-pulse-key--edit">Edit</span>
              <span class="dna-pulse-key dna-pulse-key--reject">Reject</span>
            </div>
          </div>
        }

        <!-- Preferences chart -->
        @if (prefs().length > 0) {
          <div class="dna-prefs-card" appReveal data-testid="dna-prefs-chart">
            <span class="dna-section-label">Top accepted component classes</span>
            <div class="dna-prefs-grid">
              @for (p of prefs(); track p.component_class) {
                <div class="dna-pref-row">
                  <span class="dna-pref-class">{{ p.component_class }}</span>
                  <div class="dna-pref-bar-wrap" role="img" [attr.aria-label]="p.component_class + ' net score ' + p.net_score">
                    <div
                      class="dna-pref-bar"
                      [style.width]="barWidth(p.net_score) + '%'"
                      [style.background]="p.net_score >= 0 ? 'var(--ps-accent)' : 'var(--dna-reject)'"
                    ></div>
                  </div>
                  <span class="dna-pref-score" [class.positive]="p.net_score >= 0">{{ p.net_score > 0 ? '+' : '' }}{{ p.net_score }}</span>
                </div>
              }
            </div>
          </div>
        }

        <!-- Feedback history table -->
        <div class="dna-table-wrap" appReveal tabindex="0" role="region" aria-label="Feedback history — scroll horizontally" data-testid="dna-table-scroll">
          <div class="dna-table-hdr">
            <span class="dna-section-label">Recent feedback</span>
            <!-- No manual Refresh button (real-time-data-no-manual-refresh): a
                 visibility-aware 30s auto-poll (ngOnInit) keeps this current, pausing on
                 a hidden tab and refreshing immediately on foreground. This quiet live
                 chip is the affordance — never a click. -->
            <span class="dna-live" role="status" [attr.aria-label]="'Live — ' + freshnessLabel()">
              <span class="dna-live-dot" aria-hidden="true"></span>
              <span class="dna-live-text">{{ loading() ? 'Updating…' : freshnessLabel() }}</span>
            </span>
          </div>
          <table class="dna-table" aria-label="Site DNA feedback history" [attr.aria-busy]="loading()">
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">Class</th>
                <th scope="col">Action</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              @if (loading()) {
                @for (i of [0,1,2,3,4]; track i) {
                  <tr class="dna-skel-row" aria-hidden="true">
                    <td><span class="glow-skel dna-skel-bar" style="width:72%"></span></td>
                    <td><span class="glow-skel dna-skel-bar" style="width:50%"></span></td>
                    <td><span class="glow-skel dna-skel-bar" style="width:42%"></span></td>
                    <td><span class="glow-skel dna-skel-bar" style="width:60%"></span></td>
                  </tr>
                }
              } @else if (loadError() && history().length === 0) {
                <tr>
                  <td colspan="4" class="dna-td-center">
                    <app-error-card data-testid="dna-load-error" class="block"
                      title="Couldn't load feedback history"
                      [message]="loadError() ?? ''"
                      [correlationId]="loadErrorRef()"
                      [retryLabel]="loading() ? 'Retrying…' : 'Retry'"
                      (retry)="load()" />
                  </td>
                </tr>
              } @else if (history().length === 0) {
                <tr>
                  <td colspan="4" class="dna-td-center">
                    No feedback yet. Use the form below to seed the first signal.
                  </td>
                </tr>
              } @else {
                @for (row of history(); track row.id) {
                  <tr>
                    <td class="dna-mono">{{ row.component_id }}</td>
                    <td>
                      <span class="dna-class-chip">{{ row.component_class }}</span>
                    </td>
                    <td>
                      <span class="dna-action-chip" [class]="row.action">{{ row.action }}</span>
                    </td>
                    <td class="dna-ts">{{ relativeTime(row.created_at) }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>

        <!-- Manual feedback form -->
        <div class="dna-form-card" appReveal data-testid="dna-feedback-form">
          <span class="dna-section-label">Submit manual feedback</span>
          <form class="dna-form" (ngSubmit)="submitFeedback()" #feedbackForm="ngForm">
            <div class="dna-form-row">
              <label class="dna-label" for="dna-cid">Component ID</label>
              <input
                id="dna-cid"
                hlmInput
                type="text"
                placeholder="hero-section-v2"
                [(ngModel)]="newComponentId"
                name="component_id"
                required
                minlength="1"
                data-testid="dna-component-id-input"
              />
            </div>
            <div class="dna-form-row">
              <label class="dna-label" for="dna-action">Action</label>
              <select
                id="dna-action"
                hlmSelect
                [(ngModel)]="newAction"
                name="action"
                required
                data-testid="dna-action-select"
              >
                <option value="accept">accept</option>
                <option value="reject">reject</option>
                <option value="edit">edit</option>
              </select>
            </div>
            <div class="dna-form-row">
              <label class="dna-label" for="dna-context">Context JSON <span class="dna-opt">(optional)</span></label>
              <input
                id="dna-context"
                hlmInput
                class="font-mono"
                type="text"
                placeholder='{"component_class":"hero"}'
                [(ngModel)]="newContext"
                name="context"
                data-testid="dna-context-input"
              />
            </div>
            <div class="dna-form-actions">
              @if (submitError()) {
                <span class="dna-error" role="alert">{{ submitError() }}</span>
              }
              @if (submitSuccess()) {
                <span class="dna-success" role="status">✓ Feedback recorded</span>
              }
              <button
                type="submit"
                class="dna-submit-btn"
                [disabled]="submitting() || !newComponentId || !newAction"
                data-testid="dna-submit-btn"
              >
                {{ submitting() ? 'Submitting…' : 'Submit Feedback' }}
              </button>
            </div>
          </form>
        </div>

      }
    </section>

    <style>
      /* ── Status tokens (scoped) — color-blind-safe; always paired w/ a glyph + text ── */
      .dna-shell {
        --dna-accept: #2ee6a6;
        --dna-reject: #ff5d6c;
        --dna-edit: #ffb454;
      }

      /* ── Shell ── */
      .dna-shell { padding: 20px 24px; background: var(--ps-bg, #060610); color: var(--ps-ink, #f4f4ff); display: flex; flex-direction: column; gap: 16px; }

      /* ── Header ── */
      .dna-hdr { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
      .dna-eyebrow { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--ps-accent, #00e5ff); font-weight: 600; }
      .dna-title { font-size: 20px; font-weight: 700; margin: 4px 0 4px; }
      .dna-sub { font-size: 13px; color: rgba(244,244,255,0.8); margin: 0; }
      .dna-flag-link { text-decoration: none; }
      .dna-flag-chip { background: rgba(0,229,255,0.08); border: 1px solid rgba(0,229,255,0.2); border-radius: 6px; padding: 4px 8px; font-size: 11px; color: var(--ps-accent, #00e5ff); font-family: 'JetBrains Mono', monospace; }

      /* ── Flag gate ── */
      .dna-flag-gate { padding: 20px; background: rgba(0,229,255,0.06); border: 1px solid rgba(0,229,255,0.2); border-radius: 12px; font-size: 13px; }

      /* ── Stats ── */
      .dna-stats { display: flex; gap: 24px; flex-wrap: wrap; }
      .dna-stat { display: flex; flex-direction: column; gap: 2px; font-variant-numeric: tabular-nums; }
      /* Shimmer placeholder sized like the counter value — keeps the row height
         steady (no layout shift) while the first fetch is in flight. */
      .dna-stat-skel { display: inline-block; width: 56px; height: 15px; border-radius: 5px; margin-block: 1px; }
      .dna-stat-label { font-size: 11px; color: rgba(244,244,255,0.8); display: inline-flex; align-items: center; gap: 4px; }
      .dna-glyph { display: inline-flex; align-items: center; vertical-align: -2px; }
      .dna-glyph svg { width: 12px; height: 12px; }
      .dna-stat-label--accept { color: var(--dna-accept); }
      .dna-stat-label--reject { color: var(--dna-reject); }
      .dna-stat-label--edit   { color: var(--dna-edit); }

      /* ── Taste pulse ── */
      .dna-pulse { background: rgba(0,229,255,0.04); border: 1px solid rgba(0,229,255,0.14); border-radius: 12px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
      .dna-pulse-hdr { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .dna-pulse-ratio { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ps-accent, #00e5ff); font-weight: 600; }
      .dna-pulse-bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,0.05); }
      .dna-pulse-seg { height: 100%; transition: width .5s cubic-bezier(.4,0,.2,1); }
      .dna-pulse-seg--accept { background: var(--dna-accept); }
      .dna-pulse-seg--edit   { background: var(--dna-edit); }
      .dna-pulse-seg--reject { background: var(--dna-reject); }
      .dna-pulse-legend { display: flex; gap: 14px; }
      .dna-pulse-key { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(244,244,255,0.8); display: inline-flex; align-items: center; gap: 5px; }
      .dna-pulse-key::before { content: ""; width: 8px; height: 8px; border-radius: 2px; }
      .dna-pulse-key--accept::before { background: var(--dna-accept); }
      .dna-pulse-key--edit::before   { background: var(--dna-edit); }
      .dna-pulse-key--reject::before { background: var(--dna-reject); }
      @media (prefers-reduced-motion: reduce) { .dna-pulse-seg { transition: none; } }

      /* ── Section label ── */
      .dna-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: rgba(244,244,255,0.8); font-weight: 600; }

      /* ── Preferences chart ── */
      .dna-prefs-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(0,229,255,0.1); border-radius: 12px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
      .dna-prefs-grid { display: flex; flex-direction: column; gap: 6px; }
      .dna-pref-row { display: grid; grid-template-columns: 120px 1fr 48px; align-items: center; gap: 8px; min-height: 22px; }
      .dna-pref-class { font-size: 12px; color: rgba(244,244,255,0.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dna-pref-bar-wrap { height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
      .dna-pref-bar { height: 100%; border-radius: 3px; transition: width .4s ease; min-width: 2px; }
      .dna-pref-score { font-size: 11px; font-variant-numeric: tabular-nums; color: rgba(244,244,255,0.8); text-align: right; }
      .dna-pref-score.positive { color: var(--ps-accent, #00e5ff); }

      /* ── Table ── */
      /* overflow-x:auto (not hidden) so long component ids/classes scroll into view
         at narrow widths instead of clipping unreachably (WCAG 1.4.10); overflow-y
         stays hidden to preserve the rounded-corner clip. */
      .dna-table-wrap { background: rgba(255,255,255,0.02); border: 1px solid rgba(0,229,255,0.1); border-radius: 12px; overflow-x: auto; overflow-y: hidden; }
      .dna-table-hdr { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
      /* Live affordance (replaced the manual refresh button, real-time-data-no-manual-refresh). */
      .dna-live { display: inline-flex; align-items: center; gap: 6px; }
      .dna-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dna-accept, #2ee6a6); animation: dna-live-pulse 2.4s ease-out infinite; }
      .dna-live-text { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(244,244,255,0.6); font-variant-numeric: tabular-nums; }
      @keyframes dna-live-pulse { 0% { box-shadow: 0 0 0 0 rgba(46,230,166,0.45); } 70% { box-shadow: 0 0 0 5px rgba(46,230,166,0); } 100% { box-shadow: 0 0 0 0 rgba(46,230,166,0); } }
      @media (prefers-reduced-motion: reduce) { .dna-live-dot { animation: none; } }
      .dna-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .dna-table th { padding: 7px 12px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(244,244,255,0.8); }
      .dna-table td { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); line-height: 1.3; max-height: 36px; overflow: hidden; }
      .dna-table tr:last-child td { border-bottom: none; }
      .dna-table tr:hover td { background: rgba(0,229,255,0.04); }
      .dna-td-center { text-align: center; color: rgba(244,244,255,0.8); padding: 24px !important; }
      .dna-skel-bar { display: inline-block; height: 11px; border-radius: 4px; }
      .dna-mono { font-family: 'JetBrains Mono', monospace; color: rgba(244,244,255,0.7); }
      .dna-ts { color: rgba(244,244,255,0.8); font-size: 11px; }
      .dna-class-chip { background: rgba(0,229,255,0.08); border: 1px solid rgba(0,229,255,0.15); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--ps-accent, #00e5ff); }
      .dna-action-chip { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
      .dna-action-chip.accept { background: rgba(46,230,166,0.12); color: var(--dna-accept); }
      .dna-action-chip.reject { background: rgba(255,93,108,0.12); color: var(--dna-reject); }
      .dna-action-chip.edit   { background: rgba(255,180,84,0.12); color: var(--dna-edit); }

      /* ── Form ── */
      .dna-form-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(0,229,255,0.1); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
      .dna-form { display: flex; flex-direction: column; gap: 10px; }
      .dna-form-row { display: flex; flex-direction: column; gap: 4px; }
      .dna-label { font-size: 11px; color: rgba(244,244,255,0.8); font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
      .dna-opt { text-transform: none; letter-spacing: 0; color: rgba(244,244,255,0.8); font-weight: 400; }
      /* .dna-input/.dna-select removed — now Spartan hlmInput/hlmSelect. (.dna-mono kept; shared with the table cell.) */
      .dna-form-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .dna-submit-btn { background: var(--ps-accent, #00e5ff); color: #060610; border: none; border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity .15s; }
      .dna-submit-btn:disabled { opacity: 0.45; cursor: default; }
      .dna-error { font-size: 12px; color: var(--dna-reject); }
      .dna-success { font-size: 12px; color: var(--dna-accept); }
    </style>
  `,
})
export class AdminSiteDnaComponent implements OnInit, OnDestroy {
  // siteId can come from the route param or an explicit @Input for embedding.
  @Input() siteId: string | null = null;

  private readonly api = inject(ApiService);
  private readonly flags = inject(FeatureFlagService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroy$ = new Subject<void>();

  // ── State signals ────────────────────────────────────────────────────────
  readonly loading = signal(false);
  readonly history = signal<DnaFeedbackRow[]>([]);
  readonly prefs = signal<DnaPrefRow[]>([]);
  readonly flagEnabled = signal(true); // assume on unless API 404s
  /** Epoch ms of the last successful load — drives the "updated Ns ago" live chip. */
  readonly lastSyncAt = signal(0);
  /** 1s ticker so the freshness label re-renders under OnPush without a manual refresh. */
  private readonly nowTick = signal(Date.now());
  /** Visibility-aware 30s auto-poll (real-time-data-no-manual-refresh) — pauses on a
   *  hidden tab, refreshes immediately on foreground. Mirrors AdminStateService. */
  private static readonly POLL_MS = 30_000;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler?: () => void;

  /** Quiet "updated Ns ago" live affordance (no manual refresh). */
  readonly freshnessLabel = computed(() => {
    const t = this.lastSyncAt();
    if (!t) return 'Live';
    const secs = Math.max(0, Math.floor((this.nowTick() - t) / 1000));
    if (secs < 5) return 'Live · just now';
    if (secs < 60) return `Live · ${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `Live · ${mins}m ago`;
    return `Live · ${Math.floor(mins / 60)}h ago`;
  });
  /** Set on a non-404 load failure so the table shows a Retry row, not a fake "No feedback yet". */
  readonly loadError = signal<string | null>(null);
  /** Worker request_id from a failed (non-404) load, surfaced as a copyable support reference on the error card. */
  readonly loadErrorRef = signal('');

  // ── Form state ──────────────────────────────────────────────────────────
  newComponentId = '';
  newAction: 'accept' | 'reject' | 'edit' = 'accept';
  newContext = '';
  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);
  readonly submitSuccess = signal(false);

  // ── Computed stats ───────────────────────────────────────────────────────
  readonly totalFeedback = computed(() => this.history().length);
  readonly acceptCount = computed(() => this.history().filter((r) => r.action === 'accept').length);
  readonly rejectCount = computed(() => this.history().filter((r) => r.action === 'reject').length);
  readonly editCount = computed(() => this.history().filter((r) => r.action === 'edit').length);
  readonly prefCount = computed(() => this.prefs().length);

  /**
   * True only during the FIRST load (in flight + nothing fetched yet). Gates the
   * header stat numbers to shimmer skeletons so a definitive "0 signals" never
   * flashes over the still-loading table. A manual refresh-with-data keeps the
   * existing counters visible (loading() true but history() already populated).
   */
  readonly showStatsSkeleton = computed(() => this.loading() && this.history().length === 0);

  /** Accept rate as a whole-number percent of all signals. */
  readonly acceptRatio = computed(() => {
    const total = this.totalFeedback();
    return total === 0 ? 0 : Math.round((this.acceptCount() / total) * 100);
  });

  /** Spoken-friendly summary for the taste-pulse bar (screen readers). */
  readonly pulseAriaLabel = computed(
    () =>
      `Taste pulse: ${this.acceptCount()} accepted, ${this.editCount()} edited, ` +
      `${this.rejectCount()} rejected out of ${this.totalFeedback()} signals.`,
  );

  /** Segment width as a percent of total signals (taste-pulse bar). */
  segPct(count: number): number {
    const total = this.totalFeedback();
    return total === 0 ? 0 : (count / total) * 100;
  }

  ngOnInit(): void {
    // Prefer explicit @Input; fall back to route param.
    const routeId = this.route.snapshot.paramMap.get('id');
    if (!this.siteId && routeId) this.siteId = routeId;
    // Gate the authed data fetch on the actual flag (toast-safe public probe).
    // When the flag is off we show the disabled message and never fire the
    // org-scoped fetch — which would otherwise surface a spurious "can't reach
    // the server" error toast on a feature that is intentionally disabled.
    this.flags
      .isOn('site_dna_taste_graph')
      .pipe(takeUntil(this.destroy$))
      .subscribe((on) => {
        this.flagEnabled.set(on);
        if (on) {
          this.load();
          this.startPolling();
        } else {
          this.loading.set(false);
        }
      });
    // 1s ticker keeps the "updated Ns ago" chip current under OnPush.
    this.tickTimer = setInterval(() => this.nowTick.set(Date.now()), 1000);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /**
   * Start the visibility-aware auto-poll (real-time-data-no-manual-refresh). Polls every
   * 30s but skips ticks while the tab is hidden, and refreshes immediately on foreground —
   * so the feedback history is always current without a manual Refresh button.
   */
  private startPolling(): void {
    if (this.pollTimer) return; // guard against a double flag emission
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (this.loading()) return; // don't stack an in-flight load
      this.load();
    }, AdminSiteDnaComponent.POLL_MS);
    this.visibilityHandler = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !this.loading()) {
        this.load();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  load(): void {
    if (!this.siteId) return;
    this.loading.set(true);
    this.loadError.set(null);
    this.loadErrorRef.set('');

    // {silent}: this load owns its error UX — 404 → silent flag-gate, non-404 →
    // inline loadError banner with Retry. Without {silent} ApiService's generic
    // toast double-fired over the banner (and wrongly toasted 'not found' on the
    // intended-silent 404 flag-off).
    forkJoin({
      history: this.api.get<DnaHistoryResp>(`/site-dna/${this.siteId}/history?limit=50`, undefined, { silent: true }),
      prefs: this.api.get<DnaPrefsResp>(`/site-dna/${this.siteId}/preferences?top_k=10`, undefined, { silent: true }),
    })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: ({ history, prefs }) => {
          this.flagEnabled.set(true);
          this.history.set(history.history ?? []);
          this.prefs.set(prefs.preferences ?? []);
          this.loadError.set(null);
          this.loadErrorRef.set('');
          this.loading.set(false);
          this.lastSyncAt.set(Date.now());
        },
        error: (err: { status?: number; error?: unknown }) => {
          // 404 means the flag is off (show the calm disabled message — no error
          // card, no support reference). Any other error gets the shared error
          // card with Retry + a copyable request_id — not a fake "No feedback yet".
          if (err?.status === 404) {
            this.flagEnabled.set(false);
          } else {
            this.loadError.set('The feedback history service returned an error.');
            this.loadErrorRef.set(this.requestIdFrom(err));
          }
          this.loading.set(false);
        },
      });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: { error?: unknown } | undefined): string {
    return (e?.error as { error?: { request_id?: string } } | undefined)?.error?.request_id ?? '';
  }

  submitFeedback(): void {
    if (!this.siteId || !this.newComponentId || !this.newAction) return;

    this.submitting.set(true);
    this.submitError.set(null);
    this.submitSuccess.set(false);

    let context: Record<string, unknown> | undefined;
    if (this.newContext.trim()) {
      try {
        context = JSON.parse(this.newContext) as Record<string, unknown>;
      } catch {
        this.submitError.set('Context must be valid JSON');
        this.submitting.set(false);
        return;
      }
    }

    this.api
      .post<{ id: string }>(
        `/site-dna/${this.siteId}/feedback`,
        { component_id: this.newComponentId, action: this.newAction, ...(context ? { context } : {}) },
      )
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.submitSuccess.set(true);
          this.newComponentId = '';
          this.newContext = '';
          // Reload history to show the new row.
          this.load();
          setTimeout(() => this.submitSuccess.set(false), 3500);
        },
        error: (err) => {
          this.submitting.set(false);
          const msg = (err?.error?.error?.message as string | undefined) ?? 'Submit failed. Try again.';
          this.submitError.set(msg);
        },
      });
  }

  /** Width % for preference bar (max-score normalised to 80%). */
  barWidth(score: number): number {
    const max = Math.max(...this.prefs().map((p) => Math.abs(p.net_score)), 1);
    return Math.round((Math.abs(score) / max) * 80);
  }

  /** Human-relative timestamp ("3m ago", "2d ago"). */
  relativeTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
}
