import { Component, HostListener, computed, inject, signal, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { TelemetryService } from '../../../services/telemetry.service';
import { DialogShellComponent } from '../../../components/dialog-shell/dialog-shell.component';
import { VisionRadarComponent, parseVisionScores, type VisionAxis } from './vision-radar.component';
import { FullscreenOverlayComponent } from '../../../components/fullscreen-overlay/fullscreen-overlay.component';
import { BoltEmbedService } from '../../../services/bolt-embed.service';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { CharCountComponent } from '../../../components/char-count/char-count.component';
import { HlmInputDirective } from '../../../ui';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import { RevealDirective } from '../../../directives/reveal.directive';
import { AuthImageSrcDirective } from '../../../directives/auth-image-src.directive';
import { ReadinessPanelComponent } from '../../../components/readiness-panel/readiness-panel.component';
import { HealthSparklineComponent } from '../../../components/health-sparkline/health-sparkline.component';
import { TimelineNotesComponent } from '../../../components/timeline-notes/timeline-notes.component';

/**
 * Quality metrics for a snapshot — sourced from the sibling backend route
 * `GET /api/sites/:siteId/snapshots/:snapshotId/metrics` (and the batch
 * variant `GET /api/sites/:siteId/snapshots/metrics`). Every field is
 * nullable because a snapshot may have been captured before the metrics
 * feature shipped, or the Lighthouse run may have errored on a single
 * dimension while others succeeded.
 */
interface SnapshotMetrics {
  lh_performance: number | null;
  lh_accessibility: number | null;
  lh_best_practices: number | null;
  lh_seo: number | null;
  lh_pwa: number | null;
  lcp_ms: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  si_ms: number | null;
  page_size_bytes: number | null;
  asset_count: number | null;
  request_count: number | null;
  dom_node_count: number | null;
  jsonld_block_count: number | null;
  title_chars: number | null;
  meta_desc_chars: number | null;
  h1_count: number | null;
  internal_links: number | null;
  outbound_links: number | null;
  axe_violations: number | null;
  axe_critical: number | null;
  axe_serious: number | null;
  contrast_failures: number | null;
  target_size_failures: number | null;
  screenshot_r2_key: string | null;
  captured_at: string | null;
  error: string | null;
  /** 6-axis Llama-4 Scout visual score blob (already on the wire via SELECT *). */
  vision_scores_json?: string | null;
  /** Holistic 0–10 visual score from Llama-4 Scout (distinct from the axis average). */
  vision_overall?: number | null;
  /** The model's written critique of the capture's visual quality (already stored, never surfaced until now). */
  vision_notes?: string | null;
  /** Which vision model produced the score — provenance for the critique. */
  vision_model?: string | null;
}

type MetricTier = 'green' | 'yellow' | 'red' | 'neutral';

/**
 * Snapshot row shape. We expose ONE date — sourced from the underlying git
 * commit when the GitHub mirror has stamped it (`commit_iso`), else from the
 * row insertion timestamp (`created_at`). Showing both `created_at` AND
 * `updated_at` confused users — the snapshot moment is fundamentally a
 * version-control event, so the commit timestamp is the authoritative time.
 * The worker JOINs `build_version` against the R2 git history and stamps
 * `commit_iso` on every row; a row with no git match falls back to `created_at`.
 */
interface Snapshot {
  id: string;
  snapshot_name: string;
  build_version: string;
  description: string | null;
  created_at: string;
  /** Set once the backend wires up the GitHub commit timestamp; else falls back to created_at. */
  commit_iso?: string;
  /**
   * GitHub PR metadata — populated by the editor→PR flow (Bundle B finish,
   * migration 0032). When present, the snapshot row renders a `PR #N` chip
   * linking out to the canonical github.com URL.
   */
  github_branch_name?: string | null;
  github_pr_number?: number | null;
  github_pr_html_url?: string | null;
  /**
   * Lazy-fetched quality metrics. Populated by `loadMetricsBatch()` after
   * snapshots load. Distinct nulls:
   *  - field absent on row    → metrics not yet loaded (skeleton state)
   *  - field present, null    → no Lightening run yet (empty state, "Capture now")
   *  - field present, object  → metrics row exists (render matrix)
   */
  metrics?: SnapshotMetrics | null;
}

interface GhStatus {
  connected: boolean;
  repo_html_url?: string;
  repo_full_name?: string;
  default_branch?: string;
  last_commit_sha?: string;
  commit_count?: number;
  github_user?: string;
}

@Component({
  selector: 'app-admin-snapshots',
  standalone: true,
  imports: [RevealDirective, AuthImageSrcDirective, FormsModule, DialogShellComponent, FullscreenOverlayComponent, RollingCounterComponent, CharCountComponent, HlmInputDirective, VisionRadarComponent, ReadinessPanelComponent, HealthSparklineComponent, TimelineNotesComponent, ...BrnTooltipImports],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">

      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="kicker">Time travel</div>
          <h1 class="section-h text-lg font-bold text-white m-0">Snapshots</h1>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
            Version history for
            <a
              class="text-primary font-mono no-underline hover:underline transition-colors duration-150 inline-flex items-center gap-1 group/sitelink"
              [href]="'https://' + state.selectedSite()?.slug + '.projectsites.dev'"
              target="_blank"
              rel="noopener noreferrer"
              [title]="'Open live site ' + state.selectedSite()?.slug + '.projectsites.dev in new tab'"
            >
              {{ state.selectedSite()?.slug }}.projectsites.dev
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="opacity-60 group-hover/sitelink:opacity-100 transition-opacity"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </p>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
        <button
          class="btn-create-snap btn-create-snap--primary"
          type="button"
          (click)="createOpen.set(true)"
          [disabled]="!state.selectedSite() || !siteBuildable()"
          [brnTooltip]="siteBuildable() ? 'Open the create-snapshot dialog' : 'Publish your site first — snapshots capture a published build'"
          data-testid="snapshot-create-button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          <span>Create Snapshot</span>
        </button>

        <!-- GitHub link/sync — mirrors the isomorphic-git snapshot tree to GitHub on every build. -->
        @if (!ghStatus()?.connected) {
          <button class="btn-github-link" [disabled]="linkingGh() || !state.selectedSite()" (click)="linkGithub()"
                  [attr.aria-busy]="linkingGh()" data-testid="snapshots-link-github"
                  [brnTooltip]="'Mirror snapshot history to a GitHub repo; every new snapshot will push automatically.'">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
            <span>{{ linkingGh() ? 'Opening GitHub…' : 'Link GitHub' }}</span>
          </button>
        } @else {
          <div class="btn-github-linked-wrap">
            <a class="btn-github-linked" [href]="ghStatus()!.repo_html_url" target="_blank" rel="noopener noreferrer"
               [title]="'Open ' + ghStatus()!.repo_full_name + ' on GitHub'">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
              <span class="font-mono text-[0.7rem]">{{ ghStatus()!.repo_full_name }}</span>
              @if (pushingGh()) {
                <span class="text-[0.62rem] opacity-70">syncing…</span>
              } @else if (ghStatus()!.commit_count) {
                <span class="text-[0.62rem] opacity-70">
                  <app-rolling-counter [value]="ghStatus()!.commit_count ?? 0" [duration]="900" /> commits
                </span>
              }
            </a>
            <button class="btn-github-push" [disabled]="pushingGh()" (click)="pushToGithub(true)"
                    aria-label="Push the latest build to GitHub now"
                    [brnTooltip]="'Push the latest build to GitHub now'">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   [class.animate-spin]="pushingGh()">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </button>
            <button class="btn-github-unlink" [disabled]="unlinkingGh()" (click)="unlinkGithub()"
                    aria-label="Disconnect GitHub backup" [attr.aria-busy]="unlinkingGh()"
                    [brnTooltip]="'Disconnect GitHub backup'">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        }
        </div>
      </div>

      <!-- Build-state gate — a site with no published build has no
           current_build_version, so POST /snapshots would 400
           ("Site has no published version to snapshot"). Rather than offer an
           enabled create button that dead-ends, we disable it and explain why. -->
      @if (state.selectedSite() && !siteBuildable()) {
        <div
          class="flex items-start gap-2.5 mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3.5 py-2.5 text-[0.8rem] leading-relaxed text-amber-200/90"
          role="status"
          data-testid="snapshots-build-gate">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="mt-[1px] shrink-0" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
          <span>Publish your site first — snapshots capture a published build. Once your site is live, snapshot creation unlocks automatically.</span>
        </div>
      }

      <!-- Create Snapshot — uses the standardized DialogShellComponent
           per the admin overhaul "one consistent modal primitive" rule. -->
      @if (createOpen()) {
        <app-dialog-shell (closed)="closeCreateDialog()">
          <span dialogIcon>
            <svg class="text-primary" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </span>
          <span dialogTitle>Create snapshot</span>

          <div class="p-5 flex flex-col gap-4">
            <label class="block">
              <div class="flex items-baseline justify-between mb-1">
                <span class="muted-h">Name</span>
                <span class="char-counter" [class.char-counter--full]="nameLen() >= 50">{{ nameLen() }}/50</span>
              </div>
              <input
                type="text"
                placeholder="v2, redesign, summer-2026"
                [ngModel]="newSnapshotName"
                (ngModelChange)="newSnapshotName = $event"
                hlmInput
                [error]="!!nameError()"
                class="w-full"
                maxlength="50"
                [attr.aria-invalid]="!!nameError()"
                aria-describedby="snap-name-error"
                data-testid="snapshot-name-input"
                autofocus />
              <app-char-count [value]="newSnapshotName" [max]="50" />
              @if (nameError(); as err) {
                <p id="snap-name-error" class="snap-error" role="alert" aria-live="polite">{{ err }}</p>
              }
              <p class="text-[0.66rem] text-text-secondary mt-2 leading-relaxed">
                The description is generated automatically from the build version + time. You only need to give it a name.
              </p>
            </label>
          </div>

          <div dialogFooter class="px-5 py-4 border-t border-white/[0.06] flex items-center justify-end gap-2">
            <button class="btn-ghost" type="button" (click)="closeCreateDialog()" [disabled]="creatingSnapshot()">Cancel</button>
            <button
              class="btn-accent"
              type="button"
              [disabled]="creatingSnapshot() || !canCreate()"
              data-testid="snapshot-create-submit"
              (click)="createSnapshot()">
              {{ creatingSnapshot() ? 'Creating…' : 'Create snapshot' }}
            </button>
          </div>
        </app-dialog-shell>
      }

      <!-- Production-readiness (feature: prod_readiness_score) — grades the selected
           site + surfaces the next fixes; self-hides when off / no site selected. -->
      <app-readiness-panel />

      <!-- Visits sparkline (feature: site_health_sparklines) — last-7-day traffic
           trend for the selected site; self-hides when off / no traffic. -->
      <app-health-sparkline />

      <!-- Timeline notes (feature: analytics_annotations) — annotate the site's
           timeline (deploys / campaigns / incidents); self-hides when off. -->
      <app-timeline-notes />



      <!-- Snapshot Timeline -->
      <div class="snap-card" appReveal>
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-base font-semibold text-white m-0">Version History</h3>
          <span class="text-[0.72rem] text-text-secondary">
            <app-rolling-counter [value]="snapshots().length" [duration]="900" /> snapshot{{ snapshots().length === 1 ? '' : 's' }}
          </span>
        </div>

        @if (loadingSnapshots()) {
          <div class="relative pl-6" aria-busy="true" aria-label="Loading snapshots">
            <div class="absolute left-[11px] top-[10px] bottom-0 w-[2px] bg-gradient-to-b from-primary/30 via-primary/15 to-transparent"></div>
            @for (i of [1,2,3]; track i) {
              <div class="relative pb-5">
                <div class="absolute left-[-19px] top-1 w-[14px] h-[14px] rounded-full border-2 border-white/20 bg-dark"></div>
                <div class="ml-2 bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
                  <div class="flex items-start gap-3">
                    <div class="flex-1 space-y-2">
                      <div class="skeleton h-4 w-40"></div>
                      <div class="skeleton h-3 w-56"></div>
                      <div class="skeleton h-3 w-32"></div>
                    </div>
                    <div class="skeleton h-7 w-16"></div>
                  </div>
                </div>
              </div>
            }
          </div>
        } @else if (snapshotsError()) {
          <div class="empty-state" role="alert" data-testid="snapshots-load-error">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#fca5a5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
            <h4>Couldn't load snapshots</h4>
            <p>{{ snapshotsError() }}</p>
            <button class="btn-create-snap" data-testid="snapshots-retry" (click)="retryLoadSnapshots()" [disabled]="loadingSnapshots()">
              <span>Retry</span>
            </button>
          </div>
        } @else if (snapshots().length === 0) {
          <div class="empty-state">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <h4>No snapshots yet</h4>
            <p>The first snapshot is created automatically when your site is built. You can also create one manually.</p>
            <button class="btn-create-snap" (click)="createOpen.set(true)" [disabled]="!state.selectedSite() || !siteBuildable()" [brnTooltip]="siteBuildable() ? 'Open the create-snapshot dialog' : 'Publish your site first — snapshots capture a published build'">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>
              <span>Create your first snapshot</span>
            </button>
          </div>
        } @else {
          <!-- Timeline -->
          <div class="relative pl-6 max-h-[500px] overflow-y-auto sidebar-scrollbar" data-testid="snap-timeline">
            <!-- Timeline line -->
            <div class="absolute left-[11px] top-[10px] bottom-0 w-[2px] bg-gradient-to-b from-primary/30 via-primary/15 to-transparent"></div>

            @for (snap of snapshots(); track snap.id; let first = $first; let last = $last) {
              <div class="relative pb-5 last:pb-0">
                <!-- Timeline dot -->
                <div class="absolute left-[-19px] top-1 w-[14px] h-[14px] rounded-full border-2 flex items-center justify-center"
                     [class]="first ? 'border-primary bg-primary/20 shadow-[0_0_8px_rgba(0,229,255,0.3)]' : 'border-white/20 bg-dark'">
                  @if (first) {
                    <div class="w-1.5 h-1.5 rounded-full bg-primary"></div>
                  }
                </div>

                <!-- Snapshot Card — ONE LINE: title + Latest + date + description + View + More.
                     Description gets flex:1 so it fills remaining space and ellipsis-truncates.
                     On narrow viewports (<768px) the description hides via .snap-desc-inline
                     media query, leaving the row tight + scannable. -->
                <div class="bg-white/[0.02] border border-white/[0.06] rounded-xl p-3 transition-all hover:border-primary/[0.12] ml-2"
                     [class]="first ? 'border-primary/[0.15] bg-primary/[0.02]' : ''"
                     [attr.data-testid]="'snap-row-' + snap.id">
                  <div class="snap-row">
                    <a class="snap-title"
                       [href]="'https://' + state.selectedSite()!.slug + '-' + snap.snapshot_name + '.projectsites.dev'"
                       target="_blank" rel="noopener"
                       [attr.data-testid]="'snapshot-title-' + snap.id">
                      {{ snap.snapshot_name }}
                    </a>
                    @if (first) {
                      <span class="snap-latest-chip">Latest</span>
                    }
                    @if (snap.github_pr_number && snap.github_pr_html_url) {
                      <a class="snap-pr-chip"
                         [href]="snap.github_pr_html_url"
                         target="_blank" rel="noopener noreferrer"
                         [title]="'GitHub PR opened from this snapshot (' + (snap.github_branch_name || 'branch') + ')'"
                         [attr.data-testid]="'snapshot-pr-chip-' + snap.id"
                         (click)="$event.stopPropagation()">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
                        </svg>
                        PR #{{ snap.github_pr_number }}
                      </a>
                    }
                    <span class="snap-date"
                          [title]="commitTooltip(snap)"
                          [attr.data-testid]="'snapshot-date-' + snap.id">
                      {{ commitRelative(snap) }}
                    </span>
                    @if (snap.description) {
                      <span class="snap-desc-inline"
                            [title]="snap.description"
                            [attr.data-testid]="'snapshot-desc-' + snap.id">
                        {{ snap.description }}
                      </span>
                    } @else {
                      <span class="snap-desc-inline snap-desc-inline--empty" aria-hidden="true"></span>
                    }

                    <!-- Inline CWV chips — visible without expanding the quality panel.
                         Shows "—" when individual metric data is not yet available. -->
                    @if (metricsBySnapshotId().has(snap.id) && metricsBySnapshotId().get(snap.id)) {
                      @let _m = metricsBySnapshotId().get(snap.id)!;
                      <span class="snap-cwv-chips" aria-label="Core Web Vitals at a glance">
                        @for (chip of cwvPills(_m).slice(0, 3); track chip.key) {
                          <span class="snap-cwv-chip"
                                [attr.data-tier]="chip.rawValue !== null ? chip.tier : null"
                                [brnTooltip]="chip.label + ': ' + (chip.rawValue !== null ? chip.formatted : 'no data')">
                            <span class="snap-cwv-label">{{ chip.label }}</span>
                            <span class="snap-cwv-val">{{ chip.rawValue !== null ? chip.formatted : '—' }}</span>
                          </span>
                        }
                        <span class="snap-cwv-chip"
                              [attr.data-tier]="_m.lh_performance !== null ? tierForLh(_m.lh_performance) : null"
                              [brnTooltip]="'Lighthouse Performance: ' + (_m.lh_performance !== null ? _m.lh_performance : 'no data')">
                          <span class="snap-cwv-label">LH</span>
                          <span class="snap-cwv-val">{{ _m.lh_performance !== null ? _m.lh_performance : '—' }}</span>
                        </span>
                      </span>
                    }

                    <!-- Quality chip — toggles the metrics matrix below the row.
                         Shows the overall Lighthouse perf score inline when metrics
                         are present so the chip itself communicates the headline. -->
                    @if (metricsBySnapshotId().has(snap.id) && metricsBySnapshotId().get(snap.id)) {
                      <button
                        class="snap-quality-chip"
                        type="button"
                        [class.snap-quality-chip--open]="expandedMetricsId() === snap.id"
                        [attr.aria-expanded]="expandedMetricsId() === snap.id"
                        [attr.aria-controls]="'metrics-' + snap.id"
                        [attr.aria-label]="'Toggle quality metrics for snapshot ' + snap.snapshot_name"
                        (click)="toggleMetrics(snap.id, $event)"
                        [attr.data-testid]="'snapshot-quality-' + snap.id"
                        [brnTooltip]="'Show Lighthouse + Core Web Vitals + a11y + SEO scores'">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
                          <path d="M12 2 4 7v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7l-8-5z"/>
                        </svg>
                        <span>Quality</span>
                        @if (metricsBySnapshotId().get(snap.id)?.lh_performance !== null) {
                          <span class="snap-quality-chip-score" [attr.data-tier]="tierForLh(metricsBySnapshotId().get(snap.id)!.lh_performance)">
                            <app-rolling-counter [value]="metricsBySnapshotId().get(snap.id)!.lh_performance ?? 0" [duration]="900" />
                          </span>
                        }
                      </button>
                    }

                    <!-- View + More dropdown -->
                    <div class="snap-actions">
                      <button class="btn-snap-view group"
                              type="button"
                              (click)="viewSnapshot(snap)"
                              [brnTooltip]="'Open this snapshot in a new tab'"
                              [attr.aria-label]="'Open snapshot ' + snap.snapshot_name + ' in new tab'"
                              [attr.data-testid]="'snapshot-view-' + snap.id">
                        <span class="btn-snap-view-glow" aria-hidden="true"></span>
                        <svg class="btn-snap-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        <span class="btn-snap-label">View</span>
                      </button>
                      <button
                        class="btn-snap-more"
                        type="button"
                        [attr.aria-expanded]="moreOpenId() === snap.id"
                        [attr.aria-label]="'More actions for snapshot ' + snap.snapshot_name"
                        [attr.title]="'More actions for snapshot ' + snap.snapshot_name"
                        [attr.data-testid]="'snapshot-more-' + snap.id"
                        (click)="toggleMore(snap.id, $event)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                      </button>
                      @if (moreOpenId() === snap.id) {
                        <div class="snap-more-pop" (click)="$event.stopPropagation()">
                          <!-- Item 41: rebase the editor's WebContainer to this snapshot. -->
                          <button class="snap-more-item" type="button" (click)="openInEditor(snap); moreOpenId.set(null)" [attr.data-testid]="'snapshot-open-editor-' + snap.id">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                            Open in editor
                          </button>
                          @if (!last) {
                            <button class="snap-more-item" type="button" (click)="compareWithPrevious(snap); moreOpenId.set(null)" [attr.data-testid]="'snapshot-compare-' + snap.id">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
                              Compare with previous
                            </button>
                          }
                          @if (!first) {
                            <button class="snap-more-item" type="button" [disabled]="reverting()" (click)="revertToSnapshot(snap); moreOpenId.set(null)" [attr.data-testid]="'snapshot-revert-' + snap.id">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                              {{ reverting() ? 'Reverting…' : 'Revert' }}
                            </button>
                          }
                          <button class="snap-more-item" type="button" (click)="downloadSnapshot(snap); moreOpenId.set(null)" [attr.data-testid]="'snapshot-download-' + snap.id">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download
                          </button>
                          <button class="snap-more-item snap-more-danger" type="button" (click)="confirmDelete(snap); moreOpenId.set(null)" [attr.data-testid]="'snapshot-delete-' + snap.id">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            Delete
                          </button>
                        </div>
                      }
                    </div>
                  </div>

                  <!-- ╭─ Metrics matrix + screenshot ─────────────────────────╮
                       Expanded under each snapshot row when the user clicks
                       the "Quality" chip. Renders four states:
                         (a) loading           — shimmer skeleton
                         (b) empty             — "No quality scan yet" CTA
                         (c) error             — inline error + retry
                         (d) present + open    — full matrix + 320×180 thumb
                       The matrix is always rendered as a SIBLING of the
                       snap-row (not as a popover) so it pushes neighboring
                       rows down naturally — no z-index churn. -->
                  @if (expandedMetricsId() === snap.id) {
                    <div class="snap-metrics" [attr.id]="'metrics-' + snap.id"
                         role="region"
                         [attr.aria-label]="'Quality metrics for ' + snap.snapshot_name">
                      @if (metricsLoadingIds().has(snap.id)) {
                        <!-- Shimmer skeleton matching final layout shape -->
                        <div class="snap-metrics-grid" aria-busy="true" aria-label="Loading metrics">
                          <div class="snap-metrics-screenshot skeleton"></div>
                          <div class="snap-metrics-pills">
                            <div class="snap-metric-pill-row">
                              @for (i of [1,2,3,4,5]; track i) {
                                <div class="skeleton h-12 w-full rounded-lg"></div>
                              }
                            </div>
                            <div class="snap-metric-pill-row">
                              @for (i of [1,2,3,4]; track i) {
                                <div class="skeleton h-10 w-full rounded-lg"></div>
                              }
                            </div>
                            <div class="skeleton h-7 w-full rounded-md"></div>
                            <div class="skeleton h-7 w-full rounded-md"></div>
                            <div class="skeleton h-7 w-full rounded-md"></div>
                          </div>
                        </div>
                      } @else if (metricsBySnapshotId().get(snap.id)) {
                        @let m = metricsBySnapshotId().get(snap.id)!;
                        @if (m.error) {
                          <div class="snap-metrics-error" role="alert">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <span>{{ m.error }}</span>
                            <button class="snap-metrics-retry" type="button"
                                    (click)="captureMetrics(snap)"
                                    [disabled]="capturingIds().has(snap.id)">
                              {{ capturingIds().has(snap.id) ? 'Retrying…' : 'Retry' }}
                            </button>
                          </div>
                        } @else {
                          <div class="snap-metrics-grid">
                            <!-- Screenshot thumbnail (16:9 crop of the 1920×1080 capture). -->
                            @if (m.screenshot_r2_key) {
                              <button
                                class="snap-metrics-screenshot"
                                type="button"
                                (click)="openScreenshot(snap, m)"
                                [attr.aria-label]="'Open full-resolution screenshot of ' + snap.snapshot_name"
                                [attr.data-testid]="'snapshot-screenshot-thumb-' + snap.id"
                                [brnTooltip]="'Click to view full 1920×1080 screenshot'">
                                <img
                                  [appAuthImageSrc]="screenshotUrl(snap, m)"
                                  [alt]="'Screenshot of ' + snap.snapshot_name + ' captured ' + (m.captured_at || 'recently')"
                                  loading="lazy"
                                  decoding="async"
                                  width="320"
                                  height="180" />
                                <span class="snap-metrics-screenshot-zoom" aria-hidden="true">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                                </span>
                              </button>
                            } @else {
                              <div class="snap-metrics-screenshot snap-metrics-screenshot--missing" aria-hidden="true">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                                <span>No screenshot</span>
                              </div>
                            }

                            <!-- S3 — 6-axis visual score radar + AI critique (only when AI vision scored this capture). -->
                            @if (visionAxes(m); as axes) {
                              <app-vision-radar [scores]="axes" />
                              @if (m.vision_notes) {
                                <p class="text-[0.72rem] text-text-secondary leading-relaxed m-0 mt-1 max-w-[240px] line-clamp-3"
                                   data-testid="vision-notes"
                                   [attr.title]="m.vision_notes + (m.vision_model ? ' — scored by ' + m.vision_model : '')">
                                  @if (m.vision_overall !== null && m.vision_overall !== undefined) {
                                    <span class="font-bold" [style.color]="'var(--ps-accent, #00e5ff)'">{{ m.vision_overall }}/10</span> —
                                  }
                                  {{ m.vision_notes }}
                                </p>
                              }
                            }

                            <div class="snap-metrics-pills">
                              <!-- Row 1: 5 Lighthouse scores -->
                              <div class="snap-metric-pill-row" role="group" aria-label="Lighthouse scores">
                                @for (lh of lighthousePills(m); track lh.key) {
                                  <div class="snap-metric-pill"
                                       [attr.data-tier]="lh.tier"
                                       role="meter"
                                       [attr.aria-valuenow]="lh.value ?? 0"
                                       aria-valuemin="0"
                                       aria-valuemax="100"
                                       [attr.aria-label]="lh.label + ' Lighthouse score ' + (lh.value ?? 'not available')"
                                       [title]="lh.tooltip">
                                    <span class="snap-metric-pill-ring" aria-hidden="true">
                                      <svg viewBox="0 0 32 32">
                                        <circle cx="16" cy="16" r="14" class="snap-metric-pill-ring-bg"/>
                                        <circle cx="16" cy="16" r="14"
                                                class="snap-metric-pill-ring-fg"
                                                [style.stroke-dashoffset]="ringDashOffset(lh.value)" />
                                      </svg>
                                      <span class="snap-metric-pill-value">
                                        @if (lh.value !== null) {
                                          <app-rolling-counter [value]="lh.value" [duration]="900" />
                                        } @else {
                                          —
                                        }
                                      </span>
                                    </span>
                                    <span class="snap-metric-pill-label">{{ lh.label }}</span>
                                  </div>
                                }
                              </div>

                              <!-- Row 2: 4 Core Web Vitals -->
                              <div class="snap-metric-pill-row" role="group" aria-label="Core Web Vitals">
                                @for (cwv of cwvPills(m); track cwv.key) {
                                  <div class="snap-metric-cwv"
                                       [attr.data-tier]="cwv.tier"
                                       role="meter"
                                       [attr.aria-valuenow]="cwv.rawValue ?? 0"
                                       aria-valuemin="0"
                                       [attr.aria-valuemax]="cwv.budget"
                                       [attr.aria-label]="cwv.label + ' ' + cwv.formatted + ' — ' + cwv.tooltip"
                                       [title]="cwv.tooltip">
                                    <span class="snap-metric-cwv-label">{{ cwv.label }}</span>
                                    <span class="snap-metric-cwv-value">{{ cwv.formatted }}</span>
                                  </div>
                                }
                              </div>

                              <!-- Row 3: Page composition -->
                              <div class="snap-metric-line" role="group" aria-label="Page composition">
                                <span class="snap-metric-line-label">Page</span>
                                <span class="snap-metric-line-item" [title]="'Total page size in bytes: ' + (m.page_size_bytes ?? 0)">
                                  {{ formatBytes(m.page_size_bytes) }} <em>size</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" title="HTTP requests during load">
                                  {{ formatNum(m.request_count) }} <em>requests</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" title="Distinct assets fetched">
                                  {{ formatNum(m.asset_count) }} <em>assets</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" title="DOM nodes in rendered tree">
                                  {{ formatNum(m.dom_node_count) }} <em>DOM</em>
                                </span>
                              </div>

                              <!-- Row 4: SEO -->
                              <div class="snap-metric-line" role="group" aria-label="SEO metrics">
                                <span class="snap-metric-line-label">SEO</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForTitleLen(m.title_chars)" title="Title length (target 50-60 chars)">
                                  title <em>{{ formatNum(m.title_chars) }}c</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForMetaDescLen(m.meta_desc_chars)" title="Meta description length (target 120-156 chars)">
                                  meta <em>{{ formatNum(m.meta_desc_chars) }}c</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForH1(m.h1_count)" title="H1 count (target exactly 1)">
                                  h1 <em>{{ formatNum(m.h1_count) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForJsonLd(m.jsonld_block_count)" title="JSON-LD structured-data blocks (target 4+)">
                                  json-ld <em>{{ formatNum(m.jsonld_block_count) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" title="Internal links on the page">
                                  internal <em>{{ formatNum(m.internal_links) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" title="Outbound links on the page">
                                  outbound <em>{{ formatNum(m.outbound_links) }}</em>
                                </span>
                              </div>

                              <!-- Row 5: A11y -->
                              <div class="snap-metric-line" role="group" aria-label="Accessibility metrics">
                                <span class="snap-metric-line-label">a11y</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForAxe(m.axe_violations)" title="Total axe-core violations (target 0)">
                                  axe <em>{{ formatNum(m.axe_violations) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForAxe(m.axe_critical)" title="Critical-severity axe violations">
                                  critical <em>{{ formatNum(m.axe_critical) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForAxe(m.axe_serious)" title="Serious-severity axe violations">
                                  serious <em>{{ formatNum(m.axe_serious) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForAxe(m.contrast_failures)" title="WCAG color-contrast failures (4.5:1 / 3:1)">
                                  contrast <em>{{ formatNum(m.contrast_failures) }}</em>
                                </span>
                                <span class="snap-metric-line-sep">·</span>
                                <span class="snap-metric-line-item" [attr.data-tier]="tierForAxe(m.target_size_failures)" title="WCAG 2.2 target-size failures (<24px)">
                                  targets <em>{{ formatNum(m.target_size_failures) }}</em>
                                </span>
                                @if (m.captured_at) {
                                  <span class="snap-metric-line-captured" [title]="'Captured at ' + m.captured_at">
                                    captured {{ relativeCaptured(m.captured_at) }}
                                  </span>
                                }
                              </div>
                            </div>
                          </div>
                        }
                      } @else {
                        <!-- No metrics row exists yet — surface a one-line CTA. -->
                        <div class="snap-metrics-empty">
                          <span>No quality scan yet for this snapshot.</span>
                          <button class="snap-metrics-capture" type="button"
                                  (click)="captureMetrics(snap)"
                                  [disabled]="capturingIds().has(snap.id)"
                                  [attr.data-testid]="'snapshot-capture-' + snap.id">
                            @if (capturingIds().has(snap.id)) {
                              <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                              <span>Capturing…</span>
                            } @else {
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
                              <span>Capture now</span>
                            }
                          </button>
                        </div>
                      }
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        }
      </div>

      <!-- Screenshot fullscreen overlay — reuses the standardized
           FullscreenOverlayComponent per the admin design system rule.
           Click anywhere (backdrop OR image) closes per spec. -->
      <app-fullscreen-overlay
        [open]="screenshotOpenId() !== null"
        (closed)="closeScreenshot()"
        [ariaLabel]="'Full-resolution screenshot of ' + (screenshotOpenSnapshot()?.snapshot_name || 'snapshot')">
        <span overlayTitle>{{ screenshotOpenSnapshot()?.snapshot_name }} — screenshot</span>
        <span overlaySubtitle>{{ screenshotOpenSubtitle() }}</span>
        <span overlayActions>
          <button class="fo-action-btn" type="button"
                  (click)="downloadScreenshot()"
                  data-testid="snapshot-screenshot-download"
                  title="Download PNG">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Download</span>
          </button>
        </span>
        <!-- Body — click-to-close on the wrapper AND the image both fire. -->
        <div class="snap-screenshot-stage" (click)="closeScreenshot()" data-testid="snapshot-screenshot-stage">
          @if (screenshotOpenUrl(); as url) {
            <img [appAuthImageSrc]="url"
                 [alt]="'Full-resolution screenshot of ' + (screenshotOpenSnapshot()?.snapshot_name || 'snapshot')"
                 class="snap-screenshot-img"
                 (click)="closeScreenshot()"
                 draggable="false" />
          }
        </div>
      </app-fullscreen-overlay>

    </div>
  `,
  styles: [`
    :host { display: block; --accent: #00E5FF; }
    h2, h3 { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    .snap-card { background: rgba(255,255,255,0.02); border: 1px solid color-mix(in oklch, var(--accent) 14%, transparent); border-radius: 14px; padding: 1.4rem; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02); transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease; }
    .snap-card:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 28%, transparent); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px -16px rgba(0,229,255,0.18); }
    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; padding: 2.5rem 1rem; text-align: center; }
    .empty-state .icon { width: 40px; height: 40px; opacity: 0.45; }
    .empty-state h4 { margin: 0; font-family: 'Sora', system-ui, sans-serif; font-weight: 600; color: rgba(255,255,255,0.85); font-size: 0.9rem; letter-spacing: -0.01em; }
    .empty-state p { margin: 0; font-size: 0.75rem; color: rgba(255,255,255,0.5); max-width: 36ch; }
    .skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; border-radius: 8px; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .snap-card, .btn-create-snap, .btn-github-link, .btn-github-linked { transition: none; }
      .snap-card:hover, .btn-create-snap:hover { transform: none; box-shadow: none; }
      .skeleton { animation: none; background: rgba(255,255,255,0.06); }
    }
    @media (max-width: 640px) {
      .btn-create-snap, .btn-github-link, .btn-github-linked-wrap { width: 100%; justify-content: center; }
    }
    .btn-github-link { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.75rem; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); color: #e5e7eb; font-size: 0.72rem; font-weight: 600; cursor: pointer; transition: all 150ms ease; }
    .btn-github-link:hover:not(:disabled) { background: rgba(0,229,255,0.1); border-color: rgba(0,229,255,0.35); color: #00E5FF; transform: translateY(-1px); }
    .btn-github-link:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-github-linked-wrap { display: inline-flex; align-items: stretch; border-radius: 8px; border: 1px solid rgba(0,229,255,0.25); background: rgba(0,229,255,0.06); overflow: hidden; }
    .btn-github-linked { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.38rem 0.65rem; color: #00E5FF; text-decoration: none; font-size: 0.72rem; font-weight: 600; transition: background 150ms ease; }
    .btn-github-linked:hover { background: rgba(0,229,255,0.12); }
    .btn-github-push, .btn-github-unlink { display: inline-flex; align-items: center; justify-content: center; width: 26px; border: none; border-left: 1px solid rgba(0,229,255,0.18); background: transparent; color: #00E5FF; cursor: pointer; transition: background 150ms ease, color 150ms ease; }
    .btn-github-push:hover:not(:disabled) { background: rgba(0,229,255,0.16); }
    .btn-github-unlink:hover:not(:disabled) { background: rgba(248,113,113,0.16); color: #f87171; }
    .btn-github-push:disabled, .btn-github-unlink:disabled { opacity: 0.45; cursor: not-allowed; }

    .btn-create-snap { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.85rem; border-radius: 8px; background: linear-gradient(135deg, rgba(0,229,255,0.18), rgba(0,212,255,0.10)); color: #00E5FF; border: 1px solid rgba(0,229,255,0.4); font-size: 0.74rem; font-weight: 600; cursor: pointer; transition: all 160ms ease; pointer-events: auto; }
    .btn-create-snap:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px -8px rgba(0,229,255,0.4); }
    .btn-create-snap:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Primary variant — used by the headline "Create Snapshot" action in
       the page header. Padding + font-size + radius MATCH the sibling
       btn-github-link so the header row reads as a single button group;
       the gradient + ring keep it visually dominant without size inflation. */
    .btn-create-snap--primary {
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: -0.005em;
      padding: 0.4rem 0.75rem;
      border-radius: 8px;
      color: #06121A;
      /* Cockpit is cyan/black — use the tokenized cyan primary gradient, never
         the cyan→purple it had drifted to (the brand-tokens guard only caught
         the mint-green drift, so this purple slipped through). */
      background: var(--ps-grad-primary, linear-gradient(135deg, #00E5FF, #00d4ff));
      border: 1px solid rgba(0, 229, 255, 0.55);
      box-shadow: 0 6px 18px -8px rgba(0, 229, 255, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.25);
    }
    .btn-create-snap--primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 12px 28px -8px rgba(0, 229, 255, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.32);
      filter: brightness(1.05);
    }
    .btn-create-snap--primary:focus-visible {
      outline: 2px solid #00E5FF;
      outline-offset: 3px;
    }
    @media (prefers-reduced-motion: reduce) {
      .btn-create-snap--primary { transition: none; }
      .btn-create-snap--primary:hover:not(:disabled) { transform: none; filter: none; }
    }

    .muted-h { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); font-weight: 700; }

    /* Row 1: title + Latest chip + version + date — all on one line. */
    .snap-title {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      font-feature-settings: "calt", "liga";
      font-size: 0.86rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #00E5FF;
      text-decoration: none;
      text-transform: capitalize;
    }
    .snap-title:hover { text-decoration: underline; }
    .snap-latest-chip {
      font-size: 0.58rem; font-weight: 700;
      padding: 1px 7px; border-radius: 999px;
      text-transform: uppercase; letter-spacing: 0.06em;
      background: color-mix(in oklch, oklch(0.78 0.18 220) 18%, transparent);
      color: oklch(0.86 0.16 220);
      border: 1px solid color-mix(in oklch, oklch(0.78 0.18 220) 30%, transparent);
    }
    /* PR # chip — links out to github.com pull-request URL. */
    .snap-pr-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; font-weight: 700;
      padding: 1px 8px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--ps-ink, #f4f4ff);
      border: 1px solid rgba(255, 255, 255, 0.12);
      text-decoration: none;
      transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
      flex-shrink: 0;
    }
    .snap-pr-chip:hover {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 12%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 36%, transparent);
      color: var(--ps-accent, #00E5FF);
    }
    .snap-row .snap-pr-chip { flex-shrink: 0; }
    /* One-line row: title + Latest + date + description + actions.
       - title / date / actions: flex-shrink: 0 (keep their natural width)
       - description: flex: 1 1 0 + min-width:0 so it absorbs the remaining
         horizontal space and ellipsis-truncates rather than wrapping. */
    .snap-row {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      min-width: 0;
      width: 100%;
    }
    .snap-row .snap-title { flex-shrink: 0; }
    .snap-row .snap-latest-chip { flex-shrink: 0; }
    .snap-date {
      flex-shrink: 0;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.68rem;
      color: rgba(255, 255, 255, 0.8);
      letter-spacing: 0.01em;
      white-space: nowrap;
      cursor: help;
    }
    .snap-desc-inline {
      flex: 1 1 0;
      min-width: 0;
      font-size: 0.76rem;
      color: rgba(255, 255, 255, 0.62);
      line-height: 1.4;
      text-overflow: ellipsis;
      white-space: nowrap;
      overflow: hidden;
      opacity: 0.85;
    }
    .snap-desc-inline--empty { opacity: 0; pointer-events: none; }
    .snap-actions {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      position: relative;
      margin-left: auto;
    }

    /* Narrow viewports: hide the inline description so the row stays tight
       and scannable on phones/tablets. Title + date + actions still fit. */
    @media (max-width: 768px) {
      .snap-desc-inline { display: none; }
      .snap-row { gap: 0.45rem; }
    }

    /* More dropdown — three-dots → menu with Revert/Download/Delete. */
    .btn-snap-more {
      width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      transition: background var(--ps-dur-fast, 140ms), color var(--ps-dur-fast, 140ms), border-color var(--ps-dur-fast, 140ms);
    }
    .btn-snap-more:hover { background: rgba(255, 255, 255, 0.08); color: #fff; border-color: rgba(255, 255, 255, 0.18); }
    .btn-snap-more:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: var(--ps-ring-focus-offset, 2px);
    }
    .snap-more-pop {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      min-width: 168px;
      padding: 4px;
      background: linear-gradient(180deg, rgba(20, 20, 42, 0.97), rgba(10, 10, 28, 0.97));
      border: 1px solid rgba(0, 229, 255, 0.22);
      border-radius: 10px;
      box-shadow: 0 18px 48px -16px rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(12px) saturate(140%);
      z-index: 50;
      animation: snap-more-in 160ms var(--ps-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1));
    }
    @keyframes snap-more-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .snap-more-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%;
      padding: 7px 10px;
      background: transparent; border: 0;
      color: rgba(255, 255, 255, 0.82);
      font-size: 0.78rem;
      text-align: left;
      cursor: pointer;
      border-radius: 6px;
      transition: background var(--ps-dur-fast, 140ms), color var(--ps-dur-fast, 140ms);
    }
    .snap-more-item:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
    .snap-more-item:focus-visible {
      outline: 2px solid #00E5FF;
      outline-offset: -2px;
    }
    .snap-more-item:disabled { opacity: 0.5; cursor: not-allowed; }
    .snap-more-danger { color: oklch(0.78 0.18 25); }
    .snap-more-danger:hover { background: rgba(248, 113, 113, 0.12); color: oklch(0.86 0.16 25); }
    @media (prefers-reduced-motion: reduce) {
      .snap-more-pop { animation: none; }
      .btn-snap-more { transition: none; }
    }

    /* Create-modal inputs */
    .char-counter {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.65rem;
      color: rgba(255, 255, 255, 0.5);
      letter-spacing: 0.02em;
    }
    .char-counter--full { color: oklch(0.78 0.18 25); }
    .snap-error {
      margin: 6px 0 0;
      font-size: 0.72rem;
      color: oklch(0.78 0.18 25);
      line-height: 1.35;
    }

    /* ─── Quality chip + metrics matrix ──────────────────────────────── */
    /* Threshold-coded tier colors — pulled from var(--ps-*) where possible,
       fall back to the cyan/amber/red OKLCH triplet the rest of the admin
       uses (status pills, axe gates). */
    .snap-quality-chip {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 26%, transparent);
      color: color-mix(in oklch, var(--ps-accent, #00E5FF) 70%, var(--ps-ink, #f4f4ff) 30%);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background var(--ps-dur-fast, 140ms), border-color var(--ps-dur-fast, 140ms), transform var(--ps-dur-fast, 140ms);
    }
    .snap-quality-chip:hover {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent);
      transform: translateY(-1px);
    }
    .snap-quality-chip:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: 2px;
    }
    .snap-quality-chip--open {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 18%, transparent);
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 48%, transparent);
    }
    .snap-quality-chip-score {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px; padding: 0 4px;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
      font-size: 0.62rem;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.06);
    }
    .snap-quality-chip-score[data-tier='green']  { color: oklch(0.82 0.18 150); background: color-mix(in oklch, oklch(0.82 0.18 150) 14%, transparent); }
    .snap-quality-chip-score[data-tier='yellow'] { color: oklch(0.86 0.16 80);  background: color-mix(in oklch, oklch(0.86 0.16 80)  14%, transparent); }
    .snap-quality-chip-score[data-tier='red']    { color: oklch(0.78 0.18 25);  background: color-mix(in oklch, oklch(0.78 0.18 25)  14%, transparent); }
    .snap-quality-chip-score[data-tier='neutral']{ color: rgba(255,255,255,0.65); }

    /* Inline CWV chips — shown in each snapshot row without expanding the panel. */
    .snap-cwv-chips {
      display: inline-flex; align-items: center; gap: 4px;
      flex-shrink: 0;
    }
    .snap-cwv-chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 1px 5px; border-radius: 4px;
      font-size: 10px; font-weight: 600; letter-spacing: .02em;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.55);
    }
    .snap-cwv-chip[data-tier='green']  { color: oklch(0.82 0.18 150); border-color: color-mix(in oklch, oklch(0.82 0.18 150) 30%, transparent); background: color-mix(in oklch, oklch(0.82 0.18 150) 10%, transparent); }
    .snap-cwv-chip[data-tier='yellow'] { color: oklch(0.86 0.16 80);  border-color: color-mix(in oklch, oklch(0.86 0.16 80)  30%, transparent); background: color-mix(in oklch, oklch(0.86 0.16 80)  10%, transparent); }
    .snap-cwv-chip[data-tier='red']    { color: oklch(0.78 0.18 25);  border-color: color-mix(in oklch, oklch(0.78 0.18 25)  30%, transparent); background: color-mix(in oklch, oklch(0.78 0.18 25)  10%, transparent); }
    .snap-cwv-label { opacity: .7; font-weight: 500; }
    .snap-cwv-val   { font-weight: 700; }

    /* Metrics expansion under the row.
       snap-metrics-grid: thumbnail left (fixed 320px), pills right (flex:1).
       On narrow viewports stacks vertically. */
    .snap-metrics {
      margin-top: 10px;
      padding: 12px;
      border-radius: var(--ps-radius-md, 12px);
      background: rgba(255, 255, 255, 0.015);
      border: 1px solid rgba(255, 255, 255, 0.05);
      animation: snap-metrics-in 220ms var(--ps-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1));
    }
    @keyframes snap-metrics-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .snap-metrics { animation: none; }
    }
    .snap-metrics-grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 14px;
      align-items: start;
    }
    @media (max-width: 880px) {
      .snap-metrics-grid { grid-template-columns: 1fr; }
    }

    /* Screenshot thumbnail */
    .snap-metrics-screenshot {
      position: relative;
      width: 320px; height: 180px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(0, 0, 0, 0.4);
      overflow: hidden;
      cursor: zoom-in;
      transition: border-color var(--ps-dur-fast, 140ms), box-shadow var(--ps-dur-fast, 140ms), transform var(--ps-dur-fast, 140ms);
    }
    .snap-metrics-screenshot img {
      width: 100%; height: 100%;
      object-fit: cover; object-position: top center;
      display: block;
    }
    .snap-metrics-screenshot:hover {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 40%, transparent);
      box-shadow: 0 0 0 1px color-mix(in oklch, var(--ps-accent, #00E5FF) 30%, transparent),
                  0 0 24px -6px color-mix(in oklch, var(--ps-accent, #00E5FF) 50%, transparent);
      transform: translateY(-1px);
    }
    .snap-metrics-screenshot:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: 2px;
    }
    .snap-metrics-screenshot-zoom {
      position: absolute; top: 8px; right: 8px;
      width: 26px; height: 26px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(2, 2, 12, 0.6);
      backdrop-filter: blur(6px);
      border-radius: 999px;
      color: var(--ps-accent, #00E5FF);
      opacity: 0; transition: opacity var(--ps-dur-fast, 140ms);
    }
    .snap-metrics-screenshot:hover .snap-metrics-screenshot-zoom { opacity: 1; }
    .snap-metrics-screenshot--missing {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 6px; cursor: default;
      color: rgba(255, 255, 255, 0.35);
      font-size: 0.7rem;
    }
    @media (max-width: 880px) {
      .snap-metrics-screenshot { width: 100%; height: auto; aspect-ratio: 16/9; }
    }
    @media (prefers-reduced-motion: reduce) {
      .snap-metrics-screenshot { transition: none; }
      .snap-metrics-screenshot:hover { transform: none; }
    }

    /* Pills column */
    .snap-metrics-pills { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .snap-metric-pill-row {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
    }
    .snap-metric-pill-row[aria-label='Core Web Vitals'] {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    @media (max-width: 640px) {
      .snap-metric-pill-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .snap-metric-pill-row[aria-label='Core Web Vitals'] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    /* Lighthouse pill with ring */
    .snap-metric-pill {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 6px 4px;
      border-radius: var(--ps-radius-sm, 8px);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 6%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      transition: border-color var(--ps-dur-fast, 140ms);
    }
    .snap-metric-pill:hover {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 30%, transparent);
    }
    .snap-metric-pill-ring {
      position: relative;
      width: 38px; height: 38px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .snap-metric-pill-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .snap-metric-pill-ring-bg {
      fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 3;
    }
    .snap-metric-pill-ring-fg {
      fill: none;
      stroke: currentColor;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-dasharray: 87.96; /* 2 * PI * 14 */
      transition: stroke-dashoffset 500ms var(--ps-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1));
    }
    @media (prefers-reduced-motion: reduce) {
      .snap-metric-pill-ring-fg { transition: none; }
    }
    .snap-metric-pill-value {
      position: absolute;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 0.74rem;
      font-weight: 700;
      color: var(--ps-ink, #f4f4ff);
    }
    .snap-metric-pill-label {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.56rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.62);
    }
    .snap-metric-pill[data-tier='green']   { color: oklch(0.82 0.18 150); }
    .snap-metric-pill[data-tier='yellow']  { color: oklch(0.86 0.16 80); }
    .snap-metric-pill[data-tier='red']     { color: oklch(0.78 0.18 25); }
    .snap-metric-pill[data-tier='neutral'] { color: rgba(255, 255, 255, 0.5); }

    /* Core Web Vitals pill */
    .snap-metric-cwv {
      display: flex; align-items: baseline; gap: 6px;
      padding: 6px 9px;
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .snap-metric-cwv[data-tier='green']  { border-color: color-mix(in oklch, oklch(0.82 0.18 150) 32%, transparent); }
    .snap-metric-cwv[data-tier='yellow'] { border-color: color-mix(in oklch, oklch(0.86 0.16 80) 32%, transparent); }
    .snap-metric-cwv[data-tier='red']    { border-color: color-mix(in oklch, oklch(0.78 0.18 25) 32%, transparent); }
    .snap-metric-cwv-label {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.55);
    }
    .snap-metric-cwv-value {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 0.78rem;
      font-weight: 700;
      margin-left: auto;
    }
    .snap-metric-cwv[data-tier='green']  .snap-metric-cwv-value { color: oklch(0.82 0.18 150); }
    .snap-metric-cwv[data-tier='yellow'] .snap-metric-cwv-value { color: oklch(0.86 0.16 80); }
    .snap-metric-cwv[data-tier='red']    .snap-metric-cwv-value { color: oklch(0.78 0.18 25); }
    .snap-metric-cwv[data-tier='neutral'].snap-metric-cwv-value { color: rgba(255, 255, 255, 0.55); }

    /* Inline data lines (page composition, SEO, a11y) */
    .snap-metric-line {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px;
      padding: 6px 9px;
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 0.7rem;
      color: rgba(255, 255, 255, 0.7);
    }
    .snap-metric-line-label {
      font-size: 0.58rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.45);
      font-weight: 700;
      min-width: 38px;
    }
    .snap-metric-line-item {
      display: inline-flex; align-items: baseline; gap: 3px;
    }
    .snap-metric-line-item em {
      font-style: normal;
      font-weight: 700;
      color: var(--ps-ink, #f4f4ff);
    }
    .snap-metric-line-item[data-tier='green']  em { color: oklch(0.82 0.18 150); }
    .snap-metric-line-item[data-tier='yellow'] em { color: oklch(0.86 0.16 80); }
    .snap-metric-line-item[data-tier='red']    em { color: oklch(0.78 0.18 25); }
    .snap-metric-line-sep { opacity: 0.3; }
    .snap-metric-line-captured {
      margin-left: auto;
      font-size: 0.62rem;
      opacity: 0.55;
    }

    /* Empty + error + capture states */
    .snap-metrics-empty {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px;
      font-size: 0.74rem;
      color: rgba(255, 255, 255, 0.6);
    }
    .snap-metrics-capture {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px;
      border-radius: 999px;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 36%, transparent);
      color: var(--ps-accent, #00E5FF);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.66rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      cursor: pointer;
      transition: background var(--ps-dur-fast, 140ms), transform var(--ps-dur-fast, 140ms);
    }
    .snap-metrics-capture:hover:not(:disabled) {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
      transform: translateY(-1px);
    }
    .snap-metrics-capture:disabled { opacity: 0.6; cursor: not-allowed; }
    .snap-metrics-capture:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF);
      outline-offset: 2px;
    }
    .snap-metrics-error {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px;
      font-size: 0.74rem;
      color: oklch(0.86 0.16 25);
      background: color-mix(in oklch, oklch(0.78 0.18 25) 8%, transparent);
      border-radius: var(--ps-radius-sm, 8px);
    }
    .snap-metrics-retry {
      margin-left: auto;
      padding: 3px 9px;
      border-radius: 999px;
      background: color-mix(in oklch, oklch(0.78 0.18 25) 18%, transparent);
      border: 1px solid color-mix(in oklch, oklch(0.78 0.18 25) 36%, transparent);
      color: oklch(0.86 0.16 25);
      font-size: 0.66rem;
      font-weight: 600;
      cursor: pointer;
    }
    .snap-metrics-retry:disabled { opacity: 0.6; cursor: not-allowed; }

    /* Fullscreen screenshot overlay body. The stage is a flex centerer
       that holds the image. Click handlers on BOTH stage AND image close
       per spec ("click anywhere — including the image itself"). */
    .snap-screenshot-stage {
      flex: 1; min-height: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
      cursor: zoom-out;
      overflow: auto;
    }
    .snap-screenshot-img {
      max-width: 100%; max-height: 100%;
      object-fit: contain;
      border-radius: var(--ps-radius-sm, 8px);
      box-shadow: 0 16px 48px -16px rgba(0, 0, 0, 0.6);
      cursor: zoom-out;
      user-select: none;
    }
    .fo-action-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 7px 12px;
      border-radius: var(--ps-radius-sm, 8px);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 14%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 36%, transparent);
      color: var(--ps-accent, #00E5FF);
      font-size: 0.74rem;
      font-weight: 600;
      cursor: pointer;
      transition: background var(--ps-dur-fast, 140ms);
    }
    .fo-action-btn:hover {
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 22%, transparent);
    }
  `],
})
export class AdminSnapshotsComponent implements OnInit, OnDestroy {
  state = inject(AdminStateService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirmSvc = inject(ConfirmService);
  private telemetry = inject(TelemetryService);
  private router = inject(Router);
  private bolt = inject(BoltEmbedService);

  snapshots = signal<Snapshot[]>([]);
  loadingSnapshots = signal(false);
  /** Persistent snapshot-list load failure — so a fetch error shows a Retry card, not a fake "No snapshots yet". */
  snapshotsError = signal<string | null>(null);
  newSnapshotName = '';
  newSnapshotDescription = '';
  creatingSnapshot = signal(false);
  reverting = signal(false);
  downloading = signal<string | null>(null);

  /** Cache of metrics keyed by snapshot id — written by `loadMetricsBatch`
   *  + `captureMetrics` polling. `null` value = "no metrics row yet". */
  metricsBySnapshotId = signal<Map<string, SnapshotMetrics | null>>(new Map());
  /** Snapshot ids whose metrics are currently in-flight. */
  metricsLoadingIds = signal<Set<string>>(new Set());
  /** Snapshot ids currently running the on-demand capture pipeline. */
  capturingIds = signal<Set<string>>(new Set());
  /** Which row's metrics matrix is expanded (one at a time). */
  expandedMetricsId = signal<string | null>(null);
  /** Capture-poll handles keyed by snapshot id (so we can clear on row toggle). */
  private capturePollHandles = new Map<string, ReturnType<typeof setInterval>>();

  /** Fullscreen screenshot overlay state. */
  screenshotOpenId = signal<string | null>(null);
  screenshotOpenSnapshot = computed<Snapshot | null>(() => {
    const id = this.screenshotOpenId();
    if (!id) return null;
    return this.snapshots().find((s) => s.id === id) ?? null;
  });
  screenshotOpenUrl = computed<string | null>(() => {
    const id = this.screenshotOpenId();
    const snap = this.screenshotOpenSnapshot();
    if (!id || !snap) return null;
    const m = this.metricsBySnapshotId().get(id);
    return m ? this.screenshotUrl(snap, m) : null;
  });
  screenshotOpenSubtitle = computed<string>(() => {
    const id = this.screenshotOpenId();
    if (!id) return '';
    const m = this.metricsBySnapshotId().get(id);
    if (!m?.captured_at) return '1920×1080 capture';
    return `1920×1080 · captured ${this.relativeCaptured(m.captured_at)}`;
  });

  /** Locale-aware count formatter for the "N snapshots" badge + commit-count chip. */
  private readonly numberFormatter = new Intl.NumberFormat(undefined);
  formatCount(n: number | null | undefined): string {
    return this.numberFormatter.format(typeof n === 'number' && Number.isFinite(n) ? n : 0);
  }

  /**
   * Relative-time formatter used by the inline row date ("3 hours ago",
   * "2 days ago", "just now"). Intl.RelativeTimeFormat is locale-aware and
   * cheap to instantiate once. We pick the largest unit whose absolute value
   * is >= 1, so "90 seconds" reads as "1 minute ago" not "90 seconds ago".
   */
  private readonly relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: 'auto',
    style: 'long',
  });
  private readonly absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  /**
   * Pick the canonical "git commit" timestamp for a snapshot. Prefers
   * `commit_iso` (the real GitHub commit time, set once the backend wires
   * it up), falls back to `created_at` (the moment the snapshot row was
   * inserted in D1, which is within seconds of the commit for UI-created
   * snapshots).
   */
  private commitDate(snap: Snapshot): Date {
    const iso = snap.commit_iso ?? snap.created_at;
    return new Date(iso);
  }

  commitRelative(snap: Snapshot): string {
    const date = this.commitDate(snap);
    if (Number.isNaN(date.getTime())) return '';
    const diffMs = date.getTime() - Date.now();
    const seconds = Math.round(diffMs / 1000);
    const absSec = Math.abs(seconds);
    if (absSec < 45) return this.relativeTimeFormatter.format(0, 'second').replace('in 0 seconds', 'just now');
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['year', 60 * 60 * 24 * 365],
      ['month', 60 * 60 * 24 * 30],
      ['week', 60 * 60 * 24 * 7],
      ['day', 60 * 60 * 24],
      ['hour', 60 * 60],
      ['minute', 60],
      ['second', 1],
    ];
    for (const [unit, sec] of units) {
      if (Math.abs(seconds) >= sec) {
        return this.relativeTimeFormatter.format(Math.round(seconds / sec), unit);
      }
    }
    return this.relativeTimeFormatter.format(seconds, 'second');
  }

  commitTooltip(snap: Snapshot): string {
    const date = this.commitDate(snap);
    if (Number.isNaN(date.getTime())) return '';
    const sourceLabel = snap.commit_iso ? 'git commit' : 'snapshot created';
    return `${this.absoluteDateFormatter.format(date)} (${sourceLabel})`;
  }


  ghStatus = signal<GhStatus | null>(null);
  linkingGh = signal(false);
  pushingGh = signal(false);
  unlinkingGh = signal(false);
  createOpen = signal(false);

  /**
   * True only when the selected site has a published build to snapshot.
   * The worker returns 400 ("Site has no published version to snapshot") when
   * `current_build_version` is null (POST /sites/:id/snapshots derives
   * `buildVersion = body.build_version || site.current_build_version`), so
   * gating the create action on this mirrors the exact server precondition —
   * an unbuilt site shows a "publish first" affordance instead of an enabled
   * button that dead-ends on a 400.
   */
  siteBuildable = computed<boolean>(() => !!this.state.selectedSite()?.current_build_version);

  /** Which row's "More" dropdown is open (null = none). */
  moreOpenId = signal<string | null>(null);

  /** Live counters for the create-modal char limits. */
  nameLen(): number { return this.newSnapshotName.length; }
  descLen(): number { return this.newSnapshotDescription.length; }

  /**
   * Validate the snapshot name. Returns null when valid, else a user-safe
   * error message rendered inline + announced via aria-live. Plain method
   * (not `computed()`) because `newSnapshotName` is a non-signal field —
   * memoizing here would let the error go stale between keystrokes.
   */
  nameError(): string | null {
    const raw = this.newSnapshotName.trim();
    if (raw.length === 0) return null;
    if (raw.length > 50) return 'Name must be 50 characters or fewer.';
    const lowered = raw.toLowerCase();
    const dup = this.snapshots().some((s) => (s.snapshot_name ?? '').trim().toLowerCase() === lowered);
    if (dup) return 'A snapshot with this name already exists.';
    return null;
  }

  canCreate(): boolean {
    return this.siteBuildable() && this.newSnapshotName.trim().length > 0 && this.nameError() === null;
  }

  closeCreateDialog(): void {
    if (this.creatingSnapshot()) return; // never close mid-request
    this.createOpen.set(false);
    this.newSnapshotName = '';
    this.newSnapshotDescription = '';
  }

  /** Toggle the per-row More dropdown. Click-outside is handled by the
   *  global document listener wired in {@link AdminSnapshotsComponent.ngOnInit}. */
  toggleMore(id: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.moreOpenId.update((curr) => (curr === id ? null : id));
  }

  /**
   * Download the snapshot as a real `.zip` bundle. Fetches the file manifest
   * (`GET /api/sites/:id/snapshots/:snapId/download` → `{ data: { files:[{key,url}] }}`,
   * public R2 URLs), lazy-loads jszip (own chunk — never in the initial bundle),
   * fetches each file, zips, and triggers a single-click download.
   */
  async downloadSnapshot(snap: Snapshot): Promise<void> {
    const site = this.state.selectedSite();
    if (!site || this.downloading()) return;
    this.downloading.set(snap.id);
    this.telemetry.track('snapshot.download_started', { snapshot_id: snap.id });
    this.toast.info(`Preparing "${snap.snapshot_name}" bundle…`);
    try {
      const res = await firstValueFrom(
        this.api.get<{ data?: { files?: { key: string; url: string }[] } }>(
          `/sites/${site.id}/snapshots/${snap.id}/download`,
        ),
      );
      const files = res?.data?.files ?? [];
      if (!files.length) {
        this.toast.info('This snapshot has no files to download.');
        return;
      }
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const results = await Promise.all(
        files.map(async (f) => {
          try {
            const r = await fetch(f.url);
            if (!r.ok) return false;
            zip.file(f.key, await r.blob());
            return true;
          } catch {
            return false;
          }
        }),
      );
      const ok = results.filter(Boolean).length;
      if (!ok) {
        this.toast.error('Could not fetch snapshot files — try again.');
        return;
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `${(snap.snapshot_name || 'snapshot').replace(/[^a-z0-9-_]+/gi, '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      this.telemetry.track('snapshot.download_completed', { snapshot_id: snap.id, files: ok });
      this.toast.success(`Downloaded "${snap.snapshot_name}" — ${ok} file${ok === 1 ? '' : 's'}.`);
    } catch {
      this.toast.error('Download failed — try again.');
    } finally {
      this.downloading.set(null);
    }
  }

  ngOnInit(): void {
    const site = this.state.selectedSite();
    if (site) {
      this.loadSnapshots(site.id);
      this.loadGhStatus(site.id);
    }
  }

  /**
   * Lifecycle: stop every in-flight capture poll. Each quality scan runs a 3s
   * `setInterval` for up to 90s — without this teardown the intervals (and
   * their API requests) outlive route navigation and accumulate across visits.
   */
  ngOnDestroy(): void {
    for (const handle of this.capturePollHandles.values()) clearInterval(handle);
    this.capturePollHandles.clear();
  }

  /**
   * Close the per-row "More" dropdown when the user clicks anywhere outside
   * a snap-more-pop or btn-snap-more. Bound on the host so the listener
   * tears down automatically with the component.
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (this.moreOpenId() === null) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.snap-more-pop, .btn-snap-more')) return;
    this.moreOpenId.set(null);
  }

  /** Esc closes the open ⋯ popover (keyboard dismiss — it already closes on outside click). */
  @HostListener('document:keydown.escape')
  onEscapeCloseMore(): void {
    if (this.moreOpenId() !== null) this.moreOpenId.set(null);
  }

  private loadGhStatus(siteId: string): void {
    this.api.get<{ data: GhStatus }>(`/sites/${siteId}/github/status`).subscribe({
      next: (r) => this.ghStatus.set(r.data),
      error: () => this.ghStatus.set({ connected: false }),
    });
  }

  linkGithub(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.linkingGh.set(true);
    // The /github/connect route requires Bearer auth — a raw browser
    // navigation drops the header and 401s. Fetch the OAuth URL via
    // ApiService (auth header attached), then redirect.
    // {silent}: the error branch surfaces its OWN specific message; without
    // {silent} ApiService's generic "Can't reach the server" toast double-fires.
    this.api.get<{ url: string }>(`/sites/${site.id}/github/connect`, { return_url: '/admin/snapshots' }, { silent: true }).subscribe({
      next: (r) => { if (r?.url) window.location.href = r.url; else this.linkingGh.set(false); },
      error: (err) => {
        this.linkingGh.set(false);
        const msg = err?.error?.error?.message || err?.error?.message || 'Could not start GitHub OAuth — check sign-in';
        this.toast.error(msg);
      },
    });
  }

  pushToGithub(manual: boolean): void {
    const site = this.state.selectedSite();
    const status = this.ghStatus();
    if (!site || !status?.connected) return;
    this.pushingGh.set(true);
    this.api.post<{ data: { commit_sha: string; html_url: string } }>(`/sites/${site.id}/github/backup`, {}, { silent: true }).subscribe({
      next: () => {
        this.pushingGh.set(false);
        if (manual) this.toast.success('Mirrored to GitHub');
        this.loadGhStatus(site.id);
      },
      error: (err) => {
        this.pushingGh.set(false);
        const msg = err?.error?.error?.message || 'GitHub mirror failed';
        if (manual) this.toast.error(msg);
        else this.toast.error(`Snapshot saved · GitHub mirror failed: ${msg}`);
      },
    });
  }

  async unlinkGithub(): Promise<void> {
    const site = this.state.selectedSite();
    if (!site) return;
    const ok = await this.confirmSvc.confirm({
      title: 'Disconnect GitHub mirror',
      message: 'Disconnect the GitHub mirror? The existing repo + commits stay; future snapshots will no longer push automatically.',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    this.unlinkingGh.set(true);
    this.api.post(`/sites/${site.id}/github/disconnect`, {}, { silent: true }).subscribe({
      next: () => {
        this.unlinkingGh.set(false);
        this.ghStatus.set({ connected: false });
        this.toast.success('GitHub mirror disconnected');
      },
      error: () => {
        this.unlinkingGh.set(false);
        this.toast.error('Failed to disconnect');
      },
    });
  }

  private loadSnapshots(siteId: string): void {
    this.loadingSnapshots.set(true);
    this.snapshotsError.set(null);
    this.api.get<{ data: Snapshot[] }>(`/sites/${siteId}/snapshots`).subscribe({
      next: (res) => {
        const list = res.data || [];
        this.snapshots.set(list);
        this.snapshotsError.set(null);
        this.loadingSnapshots.set(false);
        // Fire-and-forget batch metrics fetch so quality chips appear on the
        // existing rows ASAP without blocking the snapshot list render.
        if (list.length > 0) this.loadMetricsBatch(siteId);
      },
      // Silent error → empty list masqueraded as "No snapshots yet". Record it so the
      // operator sees a retry, not a fake empty (and can't think their snapshots are gone).
      error: () => {
        this.snapshotsError.set('Could not load snapshots — your snapshots are safe, retry.');
        this.loadingSnapshots.set(false);
      },
    });
  }

  /** Public retry entry point for the snapshot-list error card. */
  retryLoadSnapshots(): void {
    const site = this.state.selectedSite();
    if (site) this.loadSnapshots(site.id);
  }

  /**
   * Batch-fetch metrics for every snapshot of the active site in a single
   * round-trip. Backend (`snapshot_quality.ts`) returns
   * `{ data: Array<SnapshotMetrics & { snapshot_id }> }` — an ARRAY of enriched
   * rows (each carries its `snapshot_id` via the metrics `SELECT m.*`), NOT a
   * Record keyed by snapshot id. The old code `Object.entries(data)`'d the array
   * and keyed the cache by array INDEX ("0","1","2"), so `.get(snap.id)` always
   * missed → Quality chips never populated. Iterate the array + key by the real
   * `snapshot_id` instead.
   * We populate the cache so the Quality chip + matrix render instantly on
   * row hover/expand — no per-row spinner unless the user clicks Capture.
   */
  private loadMetricsBatch(siteId: string): void {
    this.api.get<{ data: Array<SnapshotMetrics & { snapshot_id: string }> }>(`/sites/${siteId}/snapshots/metrics`).subscribe({
      next: (res) => {
        const merged = new Map(this.metricsBySnapshotId());
        const rows = Array.isArray(res.data) ? res.data : [];
        for (const row of rows) {
          if (row?.snapshot_id) merged.set(row.snapshot_id, row);
        }
        this.metricsBySnapshotId.set(merged);
      },
      error: (err) => {
        // Silent — the per-row "Capture now" button is the fallback path.
        console.warn('[snapshots] failed to batch-load metrics', err?.message || err);
      },
    });
  }

  /**
   * Toggle the per-row metrics matrix. If the cache is empty for this row
   * (snapshot pre-dates the batch endpoint or a race lost the fetch), we
   * lazy-fetch the single row's metrics on first expand.
   */
  toggleMetrics(snapshotId: string, ev: MouseEvent): void {
    ev.stopPropagation();
    const curr = this.expandedMetricsId();
    this.expandedMetricsId.set(curr === snapshotId ? null : snapshotId);
    if (curr !== snapshotId && !this.metricsBySnapshotId().has(snapshotId)) {
      this.loadMetricsForOne(snapshotId);
    }
  }

  private loadMetricsForOne(snapshotId: string): void {
    const site = this.state.selectedSite();
    if (!site) return;
    const loading = new Set(this.metricsLoadingIds()); loading.add(snapshotId);
    this.metricsLoadingIds.set(loading);
    this.api.get<{ data: SnapshotMetrics | null }>(`/sites/${site.id}/snapshots/${snapshotId}/metrics`).subscribe({
      next: (res) => {
        const cache = new Map(this.metricsBySnapshotId());
        cache.set(snapshotId, res.data ?? null);
        this.metricsBySnapshotId.set(cache);
        const stillLoading = new Set(this.metricsLoadingIds()); stillLoading.delete(snapshotId);
        this.metricsLoadingIds.set(stillLoading);
      },
      error: () => {
        const cache = new Map(this.metricsBySnapshotId());
        cache.set(snapshotId, null);
        this.metricsBySnapshotId.set(cache);
        const stillLoading = new Set(this.metricsLoadingIds()); stillLoading.delete(snapshotId);
        this.metricsLoadingIds.set(stillLoading);
      },
    });
  }

  /**
   * Fire the on-demand capture pipeline and poll every 3 s until the
   * metrics row materializes (or 90 s elapses). Backend returns a 202 +
   * empty body; the row appears once the worker finishes the Lighthouse +
   * axe + screenshot pass.
   */
  captureMetrics(snap: Snapshot): void {
    const site = this.state.selectedSite();
    if (!site) return;
    if (this.capturingIds().has(snap.id)) return;
    const capturing = new Set(this.capturingIds()); capturing.add(snap.id);
    this.capturingIds.set(capturing);
    this.api.post(`/sites/${site.id}/snapshots/${snap.id}/capture`, {}, { silent: true }).subscribe({
      next: () => {
        this.toast.info('Quality scan started — polling for results.');
        this.startCapturePoll(site.id, snap.id);
      },
      error: (err) => {
        const stillCapturing = new Set(this.capturingIds()); stillCapturing.delete(snap.id);
        this.capturingIds.set(stillCapturing);
        const msg = err?.error?.error?.message || 'Failed to start quality scan';
        this.toast.error(msg);
      },
    });
  }

  private startCapturePoll(siteId: string, snapshotId: string): void {
    this.stopCapturePoll(snapshotId);
    const start = Date.now();
    const handle = setInterval(() => {
      if (Date.now() - start > 90_000) {
        this.stopCapturePoll(snapshotId);
        const stillCapturing = new Set(this.capturingIds()); stillCapturing.delete(snapshotId);
        this.capturingIds.set(stillCapturing);
        this.toast.warning('Quality scan is taking longer than expected — refresh the page in a minute.');
        return;
      }
      this.api.get<{ data: SnapshotMetrics | null }>(`/sites/${siteId}/snapshots/${snapshotId}/metrics`).subscribe({
        next: (res) => {
          if (res.data && !res.data.error) {
            this.stopCapturePoll(snapshotId);
            const cache = new Map(this.metricsBySnapshotId());
            cache.set(snapshotId, res.data);
            this.metricsBySnapshotId.set(cache);
            const stillCapturing = new Set(this.capturingIds()); stillCapturing.delete(snapshotId);
            this.capturingIds.set(stillCapturing);
            this.toast.success('Quality scan complete.');
          }
        },
        error: () => { /* keep polling, transient */ },
      });
    }, 3000);
    this.capturePollHandles.set(snapshotId, handle);
  }

  private stopCapturePoll(snapshotId: string): void {
    const handle = this.capturePollHandles.get(snapshotId);
    if (handle) {
      clearInterval(handle);
      this.capturePollHandles.delete(snapshotId);
    }
  }

  // ─── Screenshot overlay ────────────────────────────────────────────────
  /**
   * Resolve the public URL for a snapshot screenshot. Backend route
   * `GET /api/sites/:siteId/snapshots/:snapshotId/screenshot.png` resolves
   * the `screenshot_r2_key` server-side via signed R2 URL or proxy — the
   * frontend just requests by snapshot id, no key handling needed here.
   */
  screenshotUrl(snap: Snapshot, _metrics: SnapshotMetrics): string {
    const site = this.state.selectedSite();
    if (!site) return '';
    return `/api/sites/${site.id}/snapshots/${snap.id}/screenshot.png`;
  }

  openScreenshot(snap: Snapshot, _metrics: SnapshotMetrics): void {
    this.screenshotOpenId.set(snap.id);
    this.telemetry.track('snapshot.screenshot_opened', {
      snapshot_id: snap.id,
      site_id: this.state.selectedSite()?.id,
    });
  }

  closeScreenshot(): void {
    this.screenshotOpenId.set(null);
  }

  /**
   * Download the full-resolution PNG. We hit the same proxy endpoint and
   * pipe through an anchor with `download` set to the slug-stamped name so
   * the file lands on disk with a meaningful filename.
   */
  downloadScreenshot(): void {
    const snap = this.screenshotOpenSnapshot();
    const url = this.screenshotOpenUrl();
    const site = this.state.selectedSite();
    if (!snap || !url || !site) return;
    // The screenshot route is bearer-authed; a plain `<a href download>` can't send
    // the token → 401. Fetch the PNG WITH auth, then object-URL + click.
    this.api.getBlobAbsolute(url).subscribe({
      next: (blob) => {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = `${site.slug}-${snap.snapshot_name}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      },
      error: () => { /* ApiService already surfaced the failure. */ },
    });
    this.telemetry.track('snapshot.screenshot_downloaded', {
      snapshot_id: snap.id,
      site_id: site.id,
    });
  }

  // ─── Tier classification helpers ──────────────────────────────────────
  tierForLh(value: number | null): MetricTier {
    if (value === null || value === undefined) return 'neutral';
    if (value >= 90) return 'green';
    if (value >= 50) return 'yellow';
    return 'red';
  }

  /** SVG dash offset for the 14-radius ring. circumference = 87.96. */
  ringDashOffset(value: number | null): number {
    const v = value ?? 0;
    return 87.96 * (1 - Math.max(0, Math.min(100, v)) / 100);
  }

  /** Core Web Vitals tiers per web.dev thresholds. */
  private cwvTier(value: number | null, good: number, poor: number): MetricTier {
    if (value === null || value === undefined) return 'neutral';
    if (value <= good) return 'green';
    if (value <= poor) return 'yellow';
    return 'red';
  }

  lighthousePills(m: SnapshotMetrics): Array<{ key: string; label: string; value: number | null; tier: MetricTier; tooltip: string }> {
    return [
      { key: 'perf', label: 'Perf',  value: m.lh_performance,   tier: this.tierForLh(m.lh_performance),   tooltip: 'Lighthouse Performance score (0-100). Target ≥90.' },
      { key: 'a11y', label: 'A11y',  value: m.lh_accessibility, tier: this.tierForLh(m.lh_accessibility), tooltip: 'Lighthouse Accessibility score (0-100). Target ≥95.' },
      { key: 'bp',   label: 'BP',    value: m.lh_best_practices,tier: this.tierForLh(m.lh_best_practices),tooltip: 'Lighthouse Best Practices score (0-100). Target ≥90.' },
      { key: 'seo',  label: 'SEO',   value: m.lh_seo,           tier: this.tierForLh(m.lh_seo),           tooltip: 'Lighthouse SEO score (0-100). Target ≥95.' },
      { key: 'pwa',  label: 'PWA',   value: m.lh_pwa,           tier: this.tierForLh(m.lh_pwa),           tooltip: 'Lighthouse PWA score (0-100). Target ≥90.' },
    ];
  }

  cwvPills(m: SnapshotMetrics): Array<{ key: string; label: string; rawValue: number | null; formatted: string; tier: MetricTier; tooltip: string; budget: number }> {
    return [
      { key: 'lcp', label: 'LCP', rawValue: m.lcp_ms, formatted: this.formatMs(m.lcp_ms), tier: this.cwvTier(m.lcp_ms, 2500, 4000), budget: 4000, tooltip: 'Largest Contentful Paint. Good ≤2.5s · poor >4.0s.' },
      { key: 'cls', label: 'CLS', rawValue: m.cls,    formatted: this.formatCls(m.cls),   tier: this.cwvTier(m.cls,    0.1,  0.25), budget: 0.25, tooltip: 'Cumulative Layout Shift. Good ≤0.1 · poor >0.25.' },
      { key: 'inp', label: 'INP', rawValue: m.inp_ms, formatted: this.formatMs(m.inp_ms), tier: this.cwvTier(m.inp_ms, 200,  500),  budget: 500,  tooltip: 'Interaction to Next Paint. Good ≤200ms · poor >500ms.' },
      { key: 'tbt', label: 'TBT', rawValue: m.tbt_ms, formatted: this.formatMs(m.tbt_ms), tier: this.cwvTier(m.tbt_ms, 200,  600),  budget: 600,  tooltip: 'Total Blocking Time. Good ≤200ms · poor >600ms.' },
    ];
  }

  // SEO tier helpers — used by inline data lines (template binds via [attr.data-tier]).
  tierForTitleLen(n: number | null): MetricTier {
    if (n === null || n === undefined) return 'neutral';
    if (n >= 50 && n <= 60) return 'green';
    if (n >= 30 && n <= 70) return 'yellow';
    return 'red';
  }
  tierForMetaDescLen(n: number | null): MetricTier {
    if (n === null || n === undefined) return 'neutral';
    if (n >= 120 && n <= 156) return 'green';
    if (n >= 80 && n <= 200) return 'yellow';
    return 'red';
  }
  tierForH1(n: number | null): MetricTier {
    if (n === null || n === undefined) return 'neutral';
    if (n === 1) return 'green';
    if (n === 0 || n === 2) return 'yellow';
    return 'red';
  }
  tierForJsonLd(n: number | null): MetricTier {
    if (n === null || n === undefined) return 'neutral';
    if (n >= 4) return 'green';
    if (n >= 1) return 'yellow';
    return 'red';
  }
  tierForAxe(n: number | null): MetricTier {
    if (n === null || n === undefined) return 'neutral';
    if (n === 0) return 'green';
    if (n <= 3) return 'yellow';
    return 'red';
  }

  /** Parse a snapshot's stored 6-axis vision score into radar axes (null = none). */
  visionAxes(m: SnapshotMetrics): VisionAxis[] | null {
    return parseVisionScores(m.vision_scores_json);
  }

  // ─── Formatters ───────────────────────────────────────────────────────
  formatNum(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return this.numberFormatter.format(n);
  }
  formatMs(n: number | null): string {
    if (n === null || n === undefined) return '—';
    if (n < 1000) return `${Math.round(n)}ms`;
    return `${(n / 1000).toFixed(2)}s`;
  }
  formatCls(n: number | null): string {
    if (n === null || n === undefined) return '—';
    return n.toFixed(3);
  }
  formatBytes(n: number | null): string {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  }
  relativeCaptured(iso: string): string {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const sec = Math.round((t - Date.now()) / 1000);
    const absSec = Math.abs(sec);
    if (absSec < 60) return 'just now';
    if (absSec < 3600) return `${Math.round(absSec / 60)}m ago`;
    if (absSec < 86_400) return `${Math.round(absSec / 3600)}h ago`;
    return `${Math.round(absSec / 86_400)}d ago`;
  }

  createSnapshot(): void {
    const site = this.state.selectedSite();
    if (!site || !this.canCreate()) return;
    this.creatingSnapshot.set(true);
    // Description is auto-generated server-side from the build version + ISO
    // timestamp + actor (worker fills this in when omitted). Surfacing it as
    // a user-visible field was friction for zero gain — most snapshots ship
    // without one. Operators who need a custom note can still PATCH the row
    // via the API (`PATCH /sites/:id/snapshots/:snapId`). Local fallback so
    // the row still reads cleanly if the worker forgets to populate.
    const autoDescription = `Manual snapshot · ${new Date().toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })}`;
    this.api.post<{ data: { id: string; snapshot_name: string; build_version: string; url: string } }>(`/sites/${site.id}/snapshots`, {
      name: this.newSnapshotName.trim(),
      description: autoDescription,
    }).subscribe({
      next: (res) => {
        this.toast.success(`Snapshot created: ${res.data.snapshot_name}`);
        this.telemetry.track('snapshot.created', {
          site_id: site.id,
          snapshot_id: res.data.id,
          has_description: false, // auto-generated, not user-supplied
        });
        this.creatingSnapshot.set(false);
        this.newSnapshotName = '';
        this.newSnapshotDescription = '';
        this.createOpen.set(false);
        this.loadSnapshots(site.id);
        if (this.ghStatus()?.connected) this.pushToGithub(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.error?.message || 'Failed to create snapshot');
        this.creatingSnapshot.set(false);
      },
    });
  }

  viewSnapshot(snap: Snapshot): void {
    const site = this.state.selectedSite();
    if (!site) return;
    const url = `https://${site.slug}-${snap.snapshot_name}.projectsites.dev`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /**
   * Rebase the embedded bolt.diy WebContainer to this snapshot.
   * Falls back to opening the snapshot in a new tab when the editor iframe
   * is not yet booted (e.g. user hasn't visited /admin/editor this session).
   */
  openInEditor(snap: Snapshot): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.telemetry.track('snapshot.open_in_editor', { site_id: site.id, snapshot_id: snap.id });
    this.toast.info(`Loading "${snap.snapshot_name}" in editor…`);
    this.bolt.openSnapshot(snap.id);
  }

  /**
   * Open the snapshot diff viewer comparing this snapshot against the next-older
   * one. Surfaces the (previously orphaned) `/admin/snapshots/diff` viewer —
   * snapshots() is newest-first, so the older sibling is at index+1. The diff
   * component reads the active site from AdminStateService (shared) + from/to
   * from the query string.
   */
  compareWithPrevious(snap: Snapshot): void {
    const list = this.snapshots();
    const i = list.findIndex((s) => s.id === snap.id);
    const older = i >= 0 ? list[i + 1] : undefined;
    if (!older) {
      this.toast.info('No older snapshot to compare against.');
      return;
    }
    this.telemetry.track('snapshot.compare', { from: older.id, to: snap.id });
    this.router.navigate(['/admin/snapshots/diff'], { queryParams: { from: older.id, to: snap.id } });
  }

  async confirmDelete(snap: Snapshot): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Delete snapshot',
      message: `Permanently delete snapshot "${snap.snapshot_name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.deleteSnapshot(snap.id);
  }

  deleteSnapshot(snapshotId: string): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.api.delete(`/sites/${site.id}/snapshots/${snapshotId}`, { silent: true }).subscribe({
      next: () => {
        this.toast.success('Snapshot deleted');
        this.telemetry.track('snapshot.deleted', {
          site_id: site.id,
          snapshot_id: snapshotId,
        });
        this.loadSnapshots(site.id);
      },
      error: () => this.toast.error('Failed to delete snapshot'),
    });
  }

  async revertToSnapshot(snap: Snapshot): Promise<void> {
    const site = this.state.selectedSite();
    if (!site) return;
    // Double-submit guard: revert OVERWRITES the live site — a 2nd trigger must
    // never fire a 2nd overwrite. Claim the slot BEFORE the confirm so a rapid
    // re-trigger can't even open a 2nd dialog; cleared on cancel + on resolve/error.
    if (this.reverting()) return;
    this.reverting.set(true);
    // Reverting re-points the live production site to a past build — a
    // high-impact admin action. Confirm first, mirroring confirmDelete, so a
    // single misclick can never roll the live site back. It IS reversible (the
    // current build is itself a restorable point), but still gate it.
    const ok = await this.confirmSvc.confirm({
      title: 'Revert live site',
      message: `Revert this site to snapshot "${snap.snapshot_name}"? This replaces the current live site with that past version. You can switch back by restoring another snapshot.`,
      confirmLabel: 'Revert site',
      danger: true,
    });
    if (!ok) { this.reverting.set(false); return; }
    this.api.revertSnapshot(site.id, snap.id).subscribe({
      next: () => {
        this.toast.success(`Reverted to "${snap.snapshot_name}"`);
        this.telemetry.track('snapshot.reverted', {
          site_id: site.id,
          snapshot_id: snap.id,
        });
        this.reverting.set(false);
        this.loadSnapshots(site.id);
        this.state.loadData();
      },
      error: (err) => {
        // Restore failed (snapshot missing / build no longer in storage / network).
        // Surface the worker's message when present; the re-point is atomic, so a
        // failure means the live site was NOT changed.
        this.toast.error(
          err?.error?.error?.message ||
            'Couldn’t restore that snapshot — your live site was not changed. Try again shortly.',
          7000,
        );
        this.reverting.set(false);
      },
    });
  }
}
