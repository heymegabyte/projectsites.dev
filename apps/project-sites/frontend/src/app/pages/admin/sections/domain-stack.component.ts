/**
 * @module pages/admin/sections/domain-stack
 *
 * @description
 * Domain Stack One-Click Wizard admin surface.
 *
 * Renders a 7-tile progress board for the domain stack run associated with
 * the current site's primary hostname. Polls `GET /api/domains/:hostname/stack-status`
 * every 4s while any step is in_progress and auto-advances via
 * `POST /api/domains/:hostname/stack`.
 *
 * Route: `/admin/domains/:id/stack`
 *
 * Design tokens: `--ps-bg`, `--ps-ink`, `--ps-accent`, `--ck-warning` — never
 * hardcoded hex. All numbers use `<app-rolling-counter>`; every section uses
 * `appReveal`. A cyan completion meter (`role=progressbar`) + an `aria-live`
 * region announce setup progress; tiles carry per-step `aria-label`s and
 * `prefers-reduced-motion`-gated motion (WCAG 2.2 AA).
 *
 * @packageDocumentation
 */
import {
  Component, inject, signal, computed, effect, OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { FlagGateNoticeComponent } from '../../../components/states/flag-gate-notice.component';
import { MiniEmptyComponent } from '../../../components/mini-empty/mini-empty.component';
import { EmptyStateComponent } from '../empty-state.component';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { RevealDirective } from '../../../directives/reveal.directive';

interface StackTile {
  readonly step: string;
  readonly label: string;
  readonly status: 'pending' | 'in_progress' | 'done' | 'error';
  readonly error: string | null;
  readonly data: unknown;
}

interface StackStatusResponse {
  data: {
    run_id: string;
    hostname: string;
    state: string;
    tiles: StackTile[];
    done_at: string | null;
    last_error: string | null;
    retries: number;
  };
}

interface StackAdvanceResponse {
  data: { run_id: string; state: string; step_results: Record<string, unknown>; last_error: string | null };
}

@Component({
  selector: 'app-domain-stack',
  standalone: true,
  imports: [RevealDirective, CommonModule, RouterLink, RollingCounterComponent, MiniEmptyComponent, EmptyStateComponent, FlagGateNoticeComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto max-md:p-4 space-y-6">
      <!-- Header -->
      <header class="flex items-start justify-between gap-4 flex-wrap" appReveal>
        <div>
          <div class="kicker">Domain Stack</div>
          <h2 class="section-h text-lg font-bold text-white m-0">
            One-Click Stack Wizard
          </h2>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
            Configures DNS, SSL, email auth, security.txt, and Google Search Console in one pass.
          </p>
        </div>
        <div class="flex items-center gap-3">
          <a routerLink="/admin/domains" class="btn-ghost text-xs ds-focus">← Domains</a>
          @if (canAdvance()) {
            <button class="btn-primary text-xs ds-focus" type="button" (click)="advance()" [disabled]="advancing()"
                    [attr.aria-busy]="advancing()"
                    [attr.aria-label]="advancing() ? 'Advancing domain stack wizard' : 'Advance domain stack wizard'">
              {{ advancing() ? 'Running…' : 'Advance' }}
            </button>
          }
          @if (runId()) {
            <button class="btn-ghost text-xs ds-focus" type="button" (click)="refresh()" [disabled]="loading()"
                    [attr.aria-busy]="loading()" aria-label="Refresh stack status"><span class="inline-block text-center min-w-[11ch]">{{ loading() ? 'Refreshing…' : 'Refresh' }}</span></button>
          }
        </div>
      </header>

      <!-- Feature flag off (shared primitive). -->
      @if (featureDisabled()) {
        <app-flag-gate-notice feature="The Domain Stack Wizard" flag="domain_stack_wizard" heading="Domain Stack Wizard isn’t enabled" suffix="to run the registrar → DNS → SSL → email-auth → GSC setup board" testid="domain-stack-flag-gate" />
      }

      <!-- No site selected -->
      @if (!featureDisabled() && !state.selectedSite()) {
        <app-empty-state
          icon="🌐"
          title="No site selected"
          body="Select a site from the sidebar to start the domain stack wizard."
        />
      }

      <!-- Hostname missing -->
      @if (!featureDisabled() && state.selectedSite() && !hostname()) {
        <div class="empty-card">
          <p class="text-text-secondary text-sm">This site has no primary custom hostname yet.</p>
          <a routerLink="/admin/domains" class="btn-ghost text-xs mt-3">Add Domain →</a>
        </div>
      }

      <!-- Progress board -->
      @if (hostname() && tiles().length > 0) {
        <!-- Completion meter (cyan/black UX win) -->
        <div class="ds-meter" appReveal role="progressbar"
             [attr.aria-valuenow]="doneCount()" aria-valuemin="0" [attr.aria-valuemax]="tiles().length"
             [attr.aria-label]="doneCount() + ' of ' + tiles().length + ' stack steps complete'">
          <div class="ds-meter-fill" [style.width.%]="completionPct()"></div>
          <span class="ds-meter-label">
            <app-rolling-counter [value]="completionPct()" suffix="%" /> configured
          </span>
        </div>

        <section class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3"
                 role="list" aria-label="Domain stack setup steps">
          @for (tile of tiles(); track tile.step) {
            <div class="stack-tile" [attr.data-status]="tile.status" role="listitem"
                 [attr.aria-label]="tile.label + ': ' + statusLabel(tile.status)">
              <!-- Status icon -->
              <div class="tile-icon" aria-hidden="true">
                @if (tile.status === 'done') { <span class="tile-done"><svg class="tile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span> }
                @if (tile.status === 'in_progress') { <span class="tile-spin tile-run"><svg class="tile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg></span> }
                @if (tile.status === 'pending') { <span class="text-text-secondary"><svg class="tile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg></span> }
                @if (tile.status === 'error') { <span class="tile-err"><svg class="tile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span> }
              </div>
              <p class="tile-label">{{ tile.label }}</p>
              @if (tile.error) {
                <p class="tile-error" title="{{ tile.error }}">{{ tile.error | slice:0:60 }}</p>
              }
            </div>
          }
        </section>

        <!-- Live region: announces running step to assistive tech -->
        <p class="sr-only" role="status" aria-live="polite">{{ liveStatus() }}</p>

        <!-- Summary stats -->
        <div class="flex gap-6 text-xs text-text-secondary" appReveal>
          <span>Done: <app-rolling-counter [value]="doneCount()" /></span>
          <span>Pending: <app-rolling-counter [value]="pendingCount()" /></span>
          <span>Retries: <app-rolling-counter [value]="retries()" /></span>
        </div>

        @if (currentState() === 'done') {
          <div class="callout-success text-sm" role="status">
            Stack complete — domain is fully configured.
          </div>
        }
        @if (currentState() === 'error') {
          <div class="callout-error text-sm" role="alert">
            {{ lastError() ?? 'Stack errored — see tile above.' }}
          </div>
        }
      }

      <!-- Initial-load feedback: don't leave the board blank (no layout shift,
           announced to AT) while the first stack-status fetch is in flight. -->
      @if (!featureDisabled() && hostname() && tiles().length === 0 && loading()) {
        <div class="empty-card" role="status" aria-live="polite" aria-busy="true" data-testid="domain-stack-loading">
          <p class="text-text-secondary text-sm flex items-center gap-2">
            <span class="tile-spin tile-run" aria-hidden="true"><svg class="tile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg></span>
            Checking stack status for <strong class="text-white">{{ hostname() }}</strong>…
          </p>
        </div>
      }

      @if (!featureDisabled() && hostname() && tiles().length === 0 && !loading()) {
        <div class="empty-card">
          <app-mini-empty [text]="'No stack run yet for ' + hostname()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
          </app-mini-empty>
          <button class="btn-primary text-xs mt-3 ds-focus" type="button" (click)="start()"
                  [disabled]="advancing()" [attr.aria-busy]="advancing()"
                  aria-label="Start the domain stack wizard">{{ advancing() ? 'Starting…' : 'Start Wizard' }}</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      --ds-accent: var(--ps-accent, #00e5ff);
      --ds-warn: var(--ck-warning, #ffd166);
      --ds-err: #f87171;
      --ds-line: color-mix(in oklch, #ffffff 7%, transparent);
    }
    .stack-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 10px 8px;
      border-radius: 10px;
      border: 1px solid var(--ds-line);
      background: color-mix(in oklch, var(--ds-accent) 3%, transparent);
      text-align: center;
      transition: border-color .2s, box-shadow .2s;
    }
    .stack-tile[data-status="done"]        { border-color: color-mix(in oklch, var(--ds-accent) 35%, transparent); }
    .stack-tile[data-status="in_progress"] { border-color: color-mix(in oklch, var(--ds-warn) 45%, transparent); animation: pulse 1.5s infinite; }
    .stack-tile[data-status="error"]       { border-color: color-mix(in oklch, var(--ds-err) 45%, transparent); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.62} }
    .tile-icon { font-size:1.2rem; line-height:1; display:flex; align-items:center; justify-content:center; min-height:1.2rem; }
    /* Status glyphs are SVGs (cockpit semantic-glyph standard, cross-OS
       consistent); each inherits its semantic colour from the wrapping
       .tile-done/.tile-err/.tile-run/text-secondary span via currentColor. */
    .tile-glyph { width:1.15rem; height:1.15rem; display:block; }
    .tile-icon > span { display:inline-flex; }
    .tile-done { color: var(--ds-accent); }
    .tile-err  { color: var(--ds-err); }
    .tile-run  { color: var(--ds-warn); }
    .tile-spin { display:inline-block; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .tile-label { font-size:.65rem; color: var(--ps-ink, #f4f4ff); opacity:.8; margin:0; line-height:1.3; }
    .tile-error  { font-size:.58rem; color: var(--ds-err); margin:0; word-break:break-word; }
    .callout-success { background: color-mix(in oklch, var(--ds-accent) 8%, transparent); border:1px solid color-mix(in oklch, var(--ds-accent) 30%, transparent); border-radius:8px; padding:10px 14px; color: var(--ds-accent); }
    .callout-error   { background: color-mix(in oklch, var(--ds-err) 8%, transparent); border:1px solid color-mix(in oklch, var(--ds-err) 30%, transparent); border-radius:8px; padding:10px 14px; color: var(--ds-err); }

    /* Completion meter — cyan fill on black track */
    .ds-meter {
      position: relative;
      height: 30px;
      border-radius: 8px;
      border: 1px solid var(--ds-line);
      background: color-mix(in oklch, #000 30%, var(--ps-bg, #060610));
      overflow: hidden;
    }
    .ds-meter-fill {
      position: absolute; inset: 0 auto 0 0;
      background: linear-gradient(90deg, color-mix(in oklch, var(--ds-accent) 28%, transparent), var(--ds-accent));
      box-shadow: 0 0 18px color-mix(in oklch, var(--ds-accent) 45%, transparent);
      transition: width .5s cubic-bezier(.22,1,.36,1);
    }
    .ds-meter-label {
      position: relative; z-index: 1;
      display: flex; align-items: center; justify-content: center;
      height: 100%;
      font-size: .68rem; font-weight: 600;
      color: var(--ps-ink, #f4f4ff);
      text-shadow: 0 1px 2px rgba(0,0,0,.6);
      letter-spacing: .02em;
    }

    /* Cyan focus ring — WCAG 2.4.11/2.4.7, ≥3:1 */
    .ds-focus:focus-visible {
      outline: 2px solid var(--ds-accent);
      outline-offset: 2px;
      border-radius: 6px;
    }

    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0,0,0,0); white-space: nowrap; border: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      .stack-tile[data-status="in_progress"] { animation: none; }
      .tile-spin { animation: none; }
      .ds-meter-fill { transition: none; }
    }
  `],
})
export class AdminDomainStackComponent implements OnDestroy {
  protected readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly tiles = signal<StackTile[]>([]);
  readonly currentState = signal<string>('');
  readonly lastError = signal<string | null>(null);
  readonly retries = signal<number>(0);
  readonly runId = signal<string | null>(null);
  readonly loading = signal(false);
  /** True when the worker returns 404 feature_disabled (domain_stack_wizard flag off). */
  readonly featureDisabled = signal(false);
  readonly advancing = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly hostname = computed(() => {
    const site = this.state.selectedSite();
    return site?.primary_hostname ?? null;
  });

  readonly doneCount = computed(() => this.tiles().filter((t) => t.status === 'done').length);
  readonly pendingCount = computed(() => this.tiles().filter((t) => t.status === 'pending').length);
  /** Integer 0-100 completion for the cyan meter + rolling counter. */
  readonly completionPct = computed(() => {
    const total = this.tiles().length;
    return total === 0 ? 0 : Math.round((this.doneCount() / total) * 100);
  });
  /** ARIA live-region copy that names the currently-running step. */
  readonly liveStatus = computed(() => {
    const running = this.tiles().find((t) => t.status === 'in_progress');
    if (running) return `Configuring ${running.label}…`;
    if (this.currentState() === 'done') return 'Domain stack complete.';
    if (this.currentState() === 'error') return 'Domain stack errored.';
    return '';
  });
  readonly canAdvance = computed(() => {
    const s = this.currentState();
    return this.hostname() && s !== 'done' && s !== 'error';
  });

  /** Human-readable status word for per-tile aria-label. */
  statusLabel(status: StackTile['status']): string {
    return status === 'in_progress' ? 'in progress' : status;
  }

  constructor() {
    effect(() => {
      if (this.hostname()) this.refresh();
    });
  }

  ngOnDestroy() { this.stopPoll(); }

  refresh() {
    const hn = this.hostname();
    if (!hn) return;
    this.loading.set(true);
    // {silent}: this handler owns its error UX — 404/feature_disabled return
    // silently, a 500 shows its own 'Failed to load stack status'. Without
    // {silent} ApiService's generic toast double-fires (or wrongly toasts
    // 'not found' on the intended-silent 404).
    this.api.get<StackStatusResponse>(`/domains/${encodeURIComponent(hn)}/stack-status`, undefined, { silent: true }).subscribe({
      next: (res) => {
        const d = res.data;
        this.tiles.set(d.tiles ?? []);
        this.currentState.set(d.state);
        this.lastError.set(d.last_error);
        this.retries.set(d.retries ?? 0);
        this.runId.set(d.run_id);
        this.loading.set(false);
        if (d.state === 'in_progress' || d.tiles.some((t) => t.status === 'in_progress')) {
          this.startPoll();
        } else {
          this.stopPoll();
        }
      },
      error: (err) => {
        this.loading.set(false);
        // Flag off → worker 404s with code 'feature_disabled' → honest disabled
        // state (distinct from a genuine no-run 404, which stays the empty
        // "Start Wizard" state).
        if (err?.error?.error?.code === 'feature_disabled') { this.featureDisabled.set(true); return; }
        if (err?.status === 404) return; // no run yet → empty state
        this.toast.error('Failed to load stack status');
      },
    });
  }

  start() {
    const hn = this.hostname();
    const siteId = this.state.selectedSite()?.id;
    if (!hn || !siteId) return;
    this.advance();
  }

  advance() {
    // Double-submit guard: covers both the Advance button ([disabled] handles
    // its own re-click) AND the Start Wizard button (no [disabled] in the empty
    // state) — a rapid double-click must fire ONE POST, not two stack runs.
    if (this.advancing()) return;
    const hn = this.hostname();
    const siteId = this.state.selectedSite()?.id;
    if (!hn || !siteId) return;
    this.advancing.set(true);
    const body: Record<string, string> = { site_id: siteId };
    if (this.runId()) body['run_id'] = this.runId()!;
    // {silent}: the error callback below shows its own toast — suppress the
    // generic ApiService one so a failure shows ONE message, not two.
    this.api.post<StackAdvanceResponse>(`/domains/${encodeURIComponent(hn)}/stack`, body, { silent: true }).subscribe({
      next: (res) => {
        this.currentState.set(res.data.state);
        this.advancing.set(false);
        this.refresh();
      },
      error: () => {
        this.toast.error('Failed to advance stack wizard');
        this.advancing.set(false);
      },
    });
  }

  private startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.refresh(), 4000);
  }

  private stopPoll() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}
