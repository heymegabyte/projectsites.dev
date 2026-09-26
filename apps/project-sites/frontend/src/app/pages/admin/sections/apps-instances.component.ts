import {
  Component,
  ElementRef,
  HostListener,
  Injectable,
  ViewChild,
  computed,
  inject,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { EmptyStateComponent } from '../empty-state.component';
import { RevealDirective } from '../../../directives/reveal.directive';
import { HlmInputDirective } from '../../../ui';
import { ErrorCardComponent } from '../../../components/states';
import { APPS_CATALOG, findApp, type CatalogApp } from './apps-catalog.data';

type InstanceStatus = 'provisioning' | 'running' | 'error' | 'stopped';

interface AppInstance {
  readonly id: string;
  readonly app_id: string;
  readonly subdomain: string;
  readonly hostname: string;
  readonly status: InstanceStatus;
  readonly created_at: string;
  readonly last_activity_at: string | null;
  readonly env_keys?: ReadonlyArray<string>;
  /** A2 — live metered monthly-cost estimate from the worker (running-state + provisioned infra). */
  readonly costEstimate?: { readonly monthlyUsd: number; readonly running: boolean };
  /** A3 — last container error, surfaced so a crash isn't a silent white screen. */
  readonly last_error?: string | null;
}

interface LogLine {
  readonly ts: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
}

/**
 * Map a worker `app_instances` row → the frontend AppInstance shape. The worker
 * returns `app_slug`/`subdomain`/`last_started_at` (no `app_id`/`hostname`/
 * `last_activity_at`); hostname is derived from the subdomain. Detail rows carry
 * a decrypted `env` object → env_keys = its keys.
 */
function adaptInstance(row: Record<string, unknown>): AppInstance {
  const subdomain = String(row['subdomain'] ?? '');
  const env = row['env'];
  // Prefer the worker's authoritative public_host (CF-native Payload → .cms., container
  // apps → .app.) so the "Open" link never points at a dead/cert-broken host. Fall back
  // to the legacy .app. derivation for older rows that predate public_host.
  const publicHost = String(row['public_host'] ?? '');
  return {
    id: String(row['id'] ?? ''),
    app_id: String(row['app_slug'] ?? row['app_id'] ?? ''),
    subdomain,
    hostname: publicHost || (subdomain ? `${subdomain}.app.projectsites.dev` : ''),
    status: (row['status'] as InstanceStatus) ?? 'provisioning',
    created_at: String(row['created_at'] ?? ''),
    last_activity_at: (row['last_started_at'] ?? row['last_activity_at'] ?? null) as string | null,
    env_keys: env && typeof env === 'object' ? Object.keys(env as object) : undefined,
    costEstimate: adaptCostEstimate(row['costEstimate']),
    last_error: typeof row['last_error'] === 'string' ? (row['last_error'] as string) : null,
  };
}

/** Narrow the worker's `costEstimate` JSON into the typed shape (A2). */
function adaptCostEstimate(
  raw: unknown,
): { readonly monthlyUsd: number; readonly running: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o['monthlyUsd'] !== 'number') return undefined;
  return { monthlyUsd: o['monthlyUsd'], running: o['running'] === true };
}

const STATUS_META: Readonly<Record<InstanceStatus, { label: string; color: string }>> = {
  provisioning: { label: 'Provisioning', color: '#fbbf24' },
  running:      { label: 'Running',      color: '#34d399' },
  error:        { label: 'Error',        color: '#fca5a5' },
  stopped:      { label: 'Stopped',      color: 'rgba(255,255,255,0.5)' },
} as const;

/** Resolve a catalog entry from an instance, never throwing on stale IDs. */
function resolveApp(id: string): CatalogApp | null {
  try { return findApp(id); } catch { return APPS_CATALOG.find((a) => a.id === id) ?? null; }
}

/**
 * Admin → App Instances list.
 *
 * @remarks
 * Lists every deployed instance for the org. Each row links to a per-instance
 * detail with logs stream + env editor + restart/destroy controls. Polls
 * `/api/apps/instances` every 15s while at least one instance is in a
 * non-terminal state (`provisioning`).
 */

/**
 * Stale-while-revalidate cache of the last-loaded instances list. A root
 * singleton so it survives component teardown (re-visiting the page paints the
 * last list instantly instead of flashing a skeleton) yet is injector-scoped —
 * so it resets cleanly per test + on full page reload. Holds a perfect home for
 * the cached list per `state-is-the-enemy` (a service, not a module global).
 */
@Injectable({ providedIn: 'root' })
export class AppsInstancesCache {
  value: readonly AppInstance[] | null = null;
}

@Component({
  selector: 'app-admin-apps-instances',
  standalone: true,
  imports: [DatePipe, RouterLink, EmptyStateComponent, RevealDirective, ErrorCardComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">

      <header class="flex items-start justify-between gap-3 flex-wrap" appReveal>
        <div>
          <div class="kicker">App store</div>
          <h2 class="section-h text-lg font-bold text-white m-0 mt-1 flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="text-accent"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            App Instances
            @if (runningCount() > 0) {
              <span class="header-pill" aria-label="Running instances">
                <span class="header-pill-dot" aria-hidden="true"></span>
                {{ runningCount() }} running
              </span>
            }
          </h2>
          <p class="text-[0.78rem] text-text-secondary m-0 mt-1 max-w-prose leading-relaxed">
            Self-hosted services deployed for this org. Restart, stop, or destroy from the ⋯ menu.
          </p>
        </div>
        <div class="flex items-center gap-3">
          <a class="btn-primary" routerLink="/admin/apps">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
            <span>Deploy new app</span>
          </a>
        </div>
      </header>

      @if (loading() && instances().length === 0) {
        <div class="space-y-2" role="status" aria-live="polite" aria-busy="true" aria-label="Loading instances">
          @for (i of [0,1,2]; track i) {
            <div class="instance-row skel-row">
              <div class="skel skel-glyph"></div>
              <div class="flex-1 space-y-2">
                <div class="skel skel-line w-32"></div>
                <div class="skel skel-line w-48"></div>
              </div>
              <div class="skel skel-pill"></div>
            </div>
          }
        </div>
      } @else if (loadError() && instances().length === 0) {
        <app-error-card
          title="Couldn't load your apps"
          [message]="loadError()!"
          [correlationId]="loadErrorRef()"
          (retry)="load()" />
      } @else if (instances().length === 0) {
        <app-empty-state
          icon="🚀"
          title="No app instances yet"
          body="Deploy your first self-hosted app — Umami, Outline, Mattermost, n8n, and 30+ others available."
          primary="Browse the app store"
          (primaryClick)="goToCatalog()"
        />
      } @else {
        <div class="instance-list">
          @for (inst of instances(); track inst.id) {
            <a class="instance-row"
               appReveal
               [routerLink]="['/admin/apps/instances', inst.id]"
               [attr.data-testid]="'apps-instance-' + inst.id">
              <div class="inst-glyph" aria-hidden="true">{{ glyphFor(inst) }}</div>
              <div class="inst-main">
                <div class="inst-name">{{ nameFor(inst) }}</div>
                <a class="inst-host"
                   [href]="hostUrl(inst)"
                   target="_blank"
                   rel="noopener noreferrer"
                   (click)="$event.stopPropagation()"
                   [attr.aria-label]="'Open ' + inst.hostname">
                  {{ inst.hostname }}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
                </a>
              </div>
              <span class="status-pill" [attr.data-status]="inst.status" [style.--pill-color]="statusColor(inst.status)">
                <span class="status-dot" aria-hidden="true"></span>
                {{ statusLabel(inst.status) }}
              </span>
              @if (inst.status === 'error' && inst.last_error) {
                <span class="inst-error" role="status" [title]="inst.last_error"
                      aria-label="Last error: {{ inst.last_error }}">
                  ⚠ {{ inst.last_error }}
                </span>
              }
              <span class="inst-activity">
                @if (inst.last_activity_at) {
                  Last activity {{ inst.last_activity_at | date:'short' }}
                } @else {
                  Created {{ inst.created_at | date:'short' }}
                }
              </span>
              @if (inst.costEstimate; as ce) {
                <span class="inst-cost"
                      [attr.aria-label]="'Estimated cost ' + ce.monthlyUsd + ' dollars per month'"
                      title="Live estimate from this instance's running state + provisioned infra (not exact billing)">
                  {{ '~$' + ce.monthlyUsd }}<span class="cost-unit" aria-hidden="true">/mo</span>
                </span>
              }
              <span class="row-menu-wrap" (click)="$event.preventDefault(); $event.stopPropagation()">
                <button class="row-menu"
                        type="button"
                        (click)="toggleMenu(inst, $event)"
                        [attr.aria-label]="'Actions for ' + nameFor(inst)"
                        [attr.aria-expanded]="menuOpenId() === inst.id"
                        title="Actions">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                </button>
                @if (menuOpenId() === inst.id) {
                  <div class="row-menu-pop">
                    <button class="row-menu-item" type="button"(click)="openDetail(inst)">Open detail</button>
                    @if (inst.status === 'running' || inst.status === 'error') {
                      <button class="row-menu-item" type="button"[disabled]="acting() === inst.id" (click)="restartInstance(inst)">Restart</button>
                    }
                    @if (inst.status === 'running') {
                      <button class="row-menu-item" type="button"[disabled]="acting() === inst.id" (click)="stopInstance(inst)">Stop</button>
                    }
                    <button class="row-menu-item row-menu-danger" type="button" [disabled]="acting() === inst.id" (click)="deleteInstance(inst)">Delete</button>
                  </div>
                }
              </span>
            </a>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.62rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .section-h { font-family: 'Sora', system-ui, sans-serif; letter-spacing: -0.02em; }
    .text-accent { color: var(--ps-accent, #00E5FF); }
    .header-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: rgba(52,211,153,0.10);
      border: 1px solid rgba(52,211,153,0.32);
      color: #6ee7b7;
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 0.65rem; font-weight: 600;
    }
    .header-pill-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.7);
    }

    .instance-list { display: flex; flex-direction: column; gap: 8px; }
    .instance-row {
      display: grid;
      grid-template-columns: 44px minmax(180px, 1fr) auto auto 32px;
      gap: 1rem; align-items: center;
      padding: 0.85rem 1rem;
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      text-decoration: none; color: inherit;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }
    .instance-row:hover {
      border-color: color-mix(in oklch, var(--ps-accent, #00E5FF) 24%, transparent);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 3%, var(--ps-surface-1, rgba(13,13,40,0.62)));
      transform: translateY(-1px);
    }
    .instance-row:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .instance-row { transition: none; }
      .instance-row:hover { transform: none; }
    }
    @media (max-width: 760px) {
      .instance-row {
        grid-template-columns: 36px 1fr auto;
        grid-template-rows: auto auto;
        row-gap: 4px;
      }
      .inst-activity, .row-menu { grid-column: 2 / -1; justify-self: end; }
    }

    .inst-glyph {
      width: 44px; height: 44px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1.35rem; line-height: 1;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 18%, transparent);
      border-radius: var(--ps-radius-sm, 10px);
    }
    .inst-main { min-width: 0; }
    .inst-name {
      font-family: 'Sora', system-ui, sans-serif;
      font-weight: 700; color: var(--ps-ink, #fff);
      font-size: 0.86rem; letter-spacing: -0.01em;
    }
    .inst-host {
      display: inline-flex; align-items: center; gap: 4px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.7rem;
      color: var(--ps-accent, #00E5FF);
      text-decoration: none; margin-top: 2px;
      transition: opacity 140ms ease;
    }
    .inst-host:hover { opacity: 0.78; text-decoration: underline; }

    .status-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 0.65rem; font-weight: 700;
      background: color-mix(in oklch, var(--pill-color, #fff) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--pill-color, #fff) 36%, transparent);
      color: var(--pill-color, #fff);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .status-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--pill-color, #fff);
      box-shadow: 0 0 6px color-mix(in oklch, var(--pill-color, #fff) 60%, transparent);
    }
    .status-pill[data-status="provisioning"] .status-dot { animation: pulse 1200ms ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) {
      .status-pill[data-status="provisioning"] .status-dot { animation: none; }
    }

    .inst-activity {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.66rem; color: rgba(255,255,255,0.5);
      white-space: nowrap;
    }
    .row-menu {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid transparent;
      border-radius: 6px;
      color: rgba(255,255,255,0.55); cursor: pointer;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .row-menu:hover { background: rgba(255,255,255,0.06); color: #fff; border-color: rgba(255,255,255,0.1); }
    .row-menu:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

    /* Skeleton loaders */
    .skel-row {
      display: grid;
      grid-template-columns: 44px 1fr auto;
      gap: 1rem; align-items: center;
    }
    .skel {
      background: rgba(255,255,255,0.04);
      border-radius: 6px; overflow: hidden; position: relative;
    }
    .skel::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06) 40%, rgba(0,229,255,0.08) 50%, rgba(255,255,255,0.06) 60%, transparent);
      background-size: 200% 100%; animation: shine 1.6s linear infinite;
    }
    @keyframes shine { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .skel::after { animation: none; } }
    .skel-glyph { width: 44px; height: 44px; border-radius: 10px; }
    .skel-line { height: 10px; }
    .skel-pill { width: 90px; height: 22px; border-radius: 999px; }

    .btn-primary {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0.5rem 0.95rem;
      border-radius: var(--ps-radius-sm, 8px);
      background: rgba(0,229,255,0.12);
      color: var(--ps-accent, #00E5FF);
      font-weight: 600;
      border: 1px solid rgba(0,229,255,0.35);
      cursor: pointer;
      font-size: 0.74rem;
      text-decoration: none;
      transition: background 140ms ease, transform 140ms ease, border-color 140ms ease;
    }
    .btn-primary:hover { background: rgba(0,229,255,0.2); transform: translateY(-1px); border-color: rgba(0,229,255,0.55); }
    .btn-primary:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

    .row-menu-wrap { position: relative; display: inline-flex; }
    .row-menu-pop {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 30;
      min-width: 150px; display: flex; flex-direction: column;
      padding: 4px; border-radius: 10px;
      background: var(--ps-surface-2, rgba(12,14,24,0.98));
      border: 1px solid var(--ps-hairline, rgba(255,255,255,0.1));
      box-shadow: 0 14px 38px -16px rgba(0,0,0,0.7);
      backdrop-filter: blur(8px);
    }
    .row-menu-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%; text-align: left;
      padding: 7px 10px; border: none; background: transparent;
      color: var(--ps-ink, #f4f4ff); font-size: 0.76rem; border-radius: 6px;
      cursor: pointer; transition: background 120ms ease;
    }
    .row-menu-item:hover:not(:disabled) { background: rgba(0,229,255,0.1); }
    .row-menu-item:disabled { opacity: 0.5; cursor: progress; }
    .row-menu-item:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: -2px; }
    .row-menu-danger { color: #fca5a5; }
    .row-menu-danger:hover:not(:disabled) { background: rgba(248,113,113,0.12); }
  `],
})
export class AppInstancesComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirmSvc = inject(ConfirmService);
  private router = inject(Router);
  private cache = inject(AppsInstancesCache);

  instances = signal<readonly AppInstance[]>([]);
  loading = signal<boolean>(false);
  /** Set when the instances fetch fails — so a load error shows a Retry card, NOT a fake "No app instances yet" empty state (which could prompt re-installing an app the user already has). */
  loadError = signal<string | null>(null);
  /** Worker request_id from a failed instances load → copyable support reference on the error card. */
  loadErrorRef = signal('');
  runningCount = computed(() => this.instances().filter((i) => i.status === 'running').length);

  private pollHandle?: ReturnType<typeof setInterval>;
  /** Visibility-gated background sync — pause when the tab is hidden, catch up
   *  immediately when it returns. Keeps the list "always synced" without burning
   *  requests on a backgrounded tab (mirrors AdminStateService's pattern). */
  private readonly onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) { this.stopPolling(); }
    else { this.refresh(); this.startPolling(); }
  };

  ngOnInit(): void {
    const cached = this.cache.value;
    if (cached) {
      // Stale-while-revalidate: paint the last-known list instantly (no skeleton
      // flash on re-visit), then refresh quietly in the background.
      this.instances.set(cached);
      this.refresh();
    } else {
      this.load();
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    this.stopPolling();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** First/manual load — a failure (or stale shapeless 200) shows the retry card. */
  load(): void {
    this.fetch(false);
  }

  /** Poll-tick refresh — a stale tick keeps the prior list + toasts, never wipes. */
  refresh(): void {
    this.fetch(true);
  }

  /**
   * Fetch the instances list. `poll=true` (a 15s tick while apps provision)
   * preserves the prior healthy list on a stale/failed response — flipping a
   * live list to an error card mid-poll would be jarring + lose context.
   * `poll=false` (first/manual) degrades honestly to the inline retry card.
   *
   * Stale-route guard: a stale worker route can return a parseable-but-shapeless
   * 200 (marketing HTML / `{}`) that bypasses ApiService's 2xx→404 remap; without
   * the `Array.isArray` check `r.instances ?? []` would fake-empty the list.
   */
  private fetch(poll: boolean): void {
    if (!poll) {
      this.loading.set(true);
      this.loadError.set(null);
      this.loadErrorRef.set('');
    }
    // {silent}: the inline <app-error-card> + Retry is the accurate, persistent
    // failure UX. Without {silent} ApiService's generic "Can't reach the server"
    // toast double-fires on top of that card.
    this.api.get<{ instances: Record<string, unknown>[] }>('/apps/instances', undefined, { silent: true }).subscribe({
      next: (r) => {
        if (!r || !Array.isArray(r.instances)) {
          // Shapeless 200 — treat as a failure, never fake-empty.
          if (poll) {
            this.toast.error('Couldn’t refresh your apps — showing the last known list.');
          } else {
            this.loadError.set('Your running apps are safe — nothing was lost.');
            this.loading.set(false);
          }
          console.warn('[apps] instances response had no array — kept prior list');
          return;
        }
        const adapted = r.instances.map(adaptInstance);
        this.instances.set(adapted);
        this.cache.value = adapted; // feed the stale-while-revalidate cache
        this.loadError.set(null);
        this.loading.set(false);
        this.startPolling();
      },
      error: (err) => {
        if (poll) {
          this.toast.error('Couldn’t refresh your apps — showing the last known list.');
        } else {
          // Record the failure so the list shows a Retry card, not a fake empty.
          this.loadError.set('Your running apps are safe — nothing was lost.');
          this.loadErrorRef.set(this.requestIdFrom(err));
          this.loading.set(false);
        }
        console.warn('[apps] load instances failed');
      },
    });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: unknown): string {
    return ((e as { error?: { error?: { request_id?: string } } } | undefined)?.error?.error?.request_id) ?? '';
  }

  /** Steady-state refresh cadence: 15s while any app provisions (the list
   *  changes fast), 30s otherwise (catch external start/stop/crash). */
  private pollMs(): number {
    return this.instances().some((i) => i.status === 'provisioning') ? 15_000 : 30_000;
  }

  /** (Re)arm the background poll so the list stays synced. Never polls a hidden
   *  tab; re-arms at the current cadence after every successful fetch. */
  private startPolling(): void {
    this.stopPolling();
    if (typeof document !== 'undefined' && document.hidden) return;
    this.pollHandle = setInterval(() => this.refresh(), this.pollMs());
  }

  private stopPolling(): void {
    if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = undefined; }
  }

  glyphFor(i: AppInstance): string { return resolveApp(i.app_id)?.glyph ?? '📦'; }
  nameFor(i: AppInstance): string { return resolveApp(i.app_id)?.name ?? i.app_id; }
  hostUrl(i: AppInstance): string { return `https://${i.hostname}`; }

  statusLabel(s: InstanceStatus): string { return STATUS_META[s].label; }
  statusColor(s: InstanceStatus): string { return STATUS_META[s].color; }

  goToCatalog(): void {
    this.router.navigate(['/admin/apps']);
  }

  /** Which row's action popover is open (one at a time). */
  readonly menuOpenId = signal<string | null>(null);
  /** Per-instance in-flight guard for restart/stop/delete. */
  readonly acting = signal<string | null>(null);

  toggleMenu(inst: AppInstance, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.menuOpenId.update((c) => (c === inst.id ? null : inst.id));
  }

  /** Close the popover on any outside click (the wrap stops inside clicks). */
  @HostListener('document:click')
  closeMenu(): void {
    this.menuOpenId.set(null);
  }

  /** Esc closes the open ⋯ row popover (keyboard dismiss). */
  @HostListener('document:keydown.escape')
  onEscapeCloseMenu(): void {
    if (this.menuOpenId() !== null) this.menuOpenId.set(null);
  }

  openDetail(inst: AppInstance): void {
    this.menuOpenId.set(null);
    this.router.navigate(['/admin/apps/instances', inst.id]);
  }

  restartInstance(inst: AppInstance): void {
    this.runAction(inst, this.api.post(`/apps/instances/${inst.id}/restart`, {}), `Restarting ${this.nameFor(inst)}…`);
  }

  async stopInstance(inst: AppInstance): Promise<void> {
    // Stopping a running instance takes the live service offline until someone
    // manually restarts it — confirm so a misclick (Stop sits right above Delete
    // in the ⋯ menu) never drops a customer-facing app. Reversible → non-danger.
    const ok = await this.confirmSvc.confirm({
      title: 'Stop instance',
      message: `Stop "${this.nameFor(inst)}"? It goes offline until you restart it — visitors will see it as unavailable.`,
      confirmLabel: 'Stop',
      danger: false,
    });
    if (!ok) return;
    this.runAction(inst, this.api.post(`/apps/instances/${inst.id}/stop`, {}), `Stopping ${this.nameFor(inst)}…`);
  }

  async deleteInstance(inst: AppInstance): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Delete instance',
      message: `Delete instance "${this.nameFor(inst)}"? This destroys its container and data — this cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.runAction(inst, this.api.delete(`/apps/instances/${inst.id}`), `Deleted ${this.nameFor(inst)}`);
  }

  /** Shared restart/stop/delete runner — guards, closes the menu, reloads, toasts. */
  private runAction(inst: AppInstance, obs: Observable<unknown>, okMsg: string): void {
    if (this.acting()) return;
    this.acting.set(inst.id);
    this.menuOpenId.set(null);
    obs.subscribe({
      next: () => { this.toast.success(okMsg); this.acting.set(null); this.load(); },
      error: () => { this.acting.set(null); /* ApiService already toasts the failure */ },
    });
  }
}

/**
 * Admin → App Instance detail.
 *
 * @remarks
 * Per-instance view with logs stream + env-var editor + restart/destroy
 * controls. Logs poll every 5s while the instance is `provisioning` or
 * `running`. The backend agent wires the actual log/env/restart endpoints.
 */
@Component({
  selector: 'app-admin-apps-instance-detail',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, RevealDirective, HlmInputDirective, ErrorCardComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">

      <a class="back-link" routerLink="/admin/apps/instances">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        <span>All instances</span>
      </a>

      @if (instance(); as i) {
        <header class="detail-head" appReveal>
          <div class="head-main">
            <div class="head-glyph" aria-hidden="true">{{ catalogApp()?.glyph ?? '📦' }}</div>
            <div class="min-w-0 flex-1">
              <div class="kicker">{{ catalogApp()?.category ?? 'app' }}</div>
              <h2 class="section-h text-2xl font-bold text-white m-0 mt-1">{{ catalogApp()?.name ?? i.app_id }}</h2>
              <a class="inst-host" [href]="'https://' + i.hostname" target="_blank" rel="noopener noreferrer">
                {{ i.hostname }}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
              </a>
            </div>
            <span class="status-pill" [attr.data-status]="i.status" [style.--pill-color]="statusColor(i.status)">
              <span class="status-dot" aria-hidden="true"></span>
              {{ statusLabel(i.status) }}
            </span>
          </div>

          <div class="action-row">
            <button class="btn-ghost" type="button" (click)="restart()" [disabled]="busy()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/></svg>
              Restart
            </button>
            @if (i.status === 'running') {
              <button class="btn-ghost" type="button" (click)="stop()" [disabled]="busy()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                Stop
              </button>
            }
            <button class="btn-danger-ghost" type="button" (click)="destroy()" [disabled]="busy()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
              Destroy
            </button>
          </div>
        </header>

        <div class="grid-2col">
          <!-- ─── LOGS ─── -->
          <section class="card" appReveal [attr.aria-busy]="logsLoading()">
            <header class="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h3 class="card-h m-0">Logs</h3>
              <div class="flex items-center gap-2">
                <span class="text-[0.62rem] text-text-secondary font-mono" aria-live="polite">
                  {{ logs().length }} lines · {{ pollingLabel() }}
                </span>
                <button class="btn-tiny" type="button" (click)="refreshLogs()" [disabled]="logsLoading()" [attr.aria-label]="logsLoading() ? 'Refreshing logs' : 'Refresh logs'">
                  {{ logsLoading() ? 'Refreshing…' : 'Refresh' }}
                </button>
              </div>
            </header>
            @if (logs().length === 0) {
              <pre #logsBox class="logs-box logs-box--empty" aria-live="polite">No logs yet. Provisioning… check back in a few seconds.</pre>
            } @else {
              <pre #logsBox class="logs-box" aria-live="polite">{{ joinedLogs() }}</pre>
            }
          </section>

          <!-- ─── ENV EDITOR ─── -->
          <aside class="card" appReveal>
            <h3 class="card-h">Environment variables</h3>
            @if (!catalogApp()) {
              <p class="text-[0.78rem] text-text-secondary m-0">Catalog entry unavailable — env editor disabled.</p>
            } @else {
              <div class="env-list">
                @for (e of catalogApp()!.env; track e.key) {
                  <label class="env-field">
                    <span class="env-field-label">
                      <code>{{ e.key }}</code>
                      @if (e.required) { <span class="env-req">*</span> }
                      @if (e.auto) { <span class="env-auto-mini">auto</span> }
                    </span>
                    <input type="text"
                           hlmInput
                           class="font-mono text-xs"
                           maxlength="8000"
                           [placeholder]="e.auto ? '(auto-resolved)' : (e.default ?? 'set value')"
                           [(ngModel)]="envValues[e.key]"
                           [disabled]="!!e.auto"
                           [attr.data-testid]="'env-input-' + e.key"
                           [attr.aria-label]="e.key" />
                    <span class="env-desc">{{ e.description }}</span>
                  </label>
                }
              </div>
              @if (requiredEnvMissing().length) {
                <p class="text-[0.72rem] m-0 mt-2" style="color: var(--ps-warning, #ffb454);" role="alert" data-testid="env-required-hint">
                  Required before restart: {{ requiredEnvMissing().join(', ') }}
                </p>
              }
              <button class="btn-primary mt-3" type="button" (click)="saveEnv()"
                      [disabled]="busy() || requiredEnvMissing().length > 0"
                      [attr.aria-disabled]="busy() || requiredEnvMissing().length > 0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save &amp; restart
              </button>
            }

            <div class="meta-grid mt-5">
              <div class="meta-cell">
                <span class="meta-cell-k">Instance ID</span>
                <code class="meta-cell-v">{{ i.id }}</code>
              </div>
              <div class="meta-cell">
                <span class="meta-cell-k">Created</span>
                <span class="meta-cell-v">{{ i.created_at | date:'medium' }}</span>
              </div>
              @if (i.last_activity_at) {
                <div class="meta-cell">
                  <span class="meta-cell-k">Last activity</span>
                  <span class="meta-cell-v">{{ i.last_activity_at | date:'medium' }}</span>
                </div>
              }
            </div>
          </aside>
        </div>
      } @else if (notFound()) {
        <div class="card notice notice-red" role="alert">
          <strong>Instance not found.</strong>
          <span class="block text-[0.74rem] mt-1">No instance with id <code class="font-mono">{{ instanceId() }}</code>.</span>
        </div>
      } @else if (loadFailed()) {
        <app-error-card
          title="Couldn't load this instance"
          message="The instance failed to load — it may be a temporary network issue."
          [correlationId]="loadErrorRef()"
          (retry)="load()" />
      } @else {
        <div class="card notice notice-red" role="alert">
          <strong>Instance not found.</strong>
          <span class="block text-[0.74rem] mt-1">No instance with id <code class="font-mono">{{ instanceId() }}</code>.</span>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.6rem; font-weight: 700; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85;
    }
    .section-h { font-family: 'Sora', system-ui, sans-serif; letter-spacing: -0.02em; }
    .card-h { font-family: 'Sora', system-ui, sans-serif; font-size: 0.78rem; font-weight: 700; color: #fff; margin: 0 0 0.7rem 0; }

    .back-link {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em;
      color: rgba(255,255,255,0.62);
      text-decoration: none; padding: 4px 8px;
      border-radius: 6px;
    }
    .back-link:hover { color: var(--ps-accent, #00E5FF); background: rgba(255,255,255,0.04); }
    .back-link:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }

    .detail-head {
      display: flex; flex-direction: column; gap: 1rem;
    }
    .head-main {
      display: flex; align-items: flex-start; gap: 1rem;
      padding: 1.2rem;
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-xl, 22px);
    }
    .head-glyph {
      flex-shrink: 0;
      width: 64px; height: 64px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 2.2rem; line-height: 1;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 24%, transparent);
      border-radius: var(--ps-radius-sm, 12px);
    }
    .inst-host {
      display: inline-flex; align-items: center; gap: 4px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.78rem;
      color: var(--ps-accent, #00E5FF);
      text-decoration: none; margin-top: 4px;
    }
    .inst-host:hover { text-decoration: underline; }

    .status-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 9px; border-radius: 999px;
      font-size: 0.65rem; font-weight: 700;
      background: color-mix(in oklch, var(--pill-color, #fff) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--pill-color, #fff) 36%, transparent);
      color: var(--pill-color, #fff);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
      align-self: flex-start;
    }
    .status-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--pill-color, #fff);
      box-shadow: 0 0 6px color-mix(in oklch, var(--pill-color, #fff) 60%, transparent);
    }
    .status-pill[data-status="provisioning"] .status-dot { animation: pulse 1200ms ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) {
      .status-pill[data-status="provisioning"] .status-dot { animation: none; }
    }

    .action-row { display: flex; flex-wrap: wrap; gap: 6px; }

    .grid-2col {
      display: grid; gap: 1.25rem;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    }
    @media (max-width: 1000px) { .grid-2col { grid-template-columns: 1fr; } }

    .card {
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      padding: 1.2rem;
    }

    .logs-box {
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-sm, 8px);
      padding: 0.85rem 1rem;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.7rem; line-height: 1.55;
      color: rgba(255,255,255,0.86);
      min-height: 360px; max-height: 540px;
      overflow: auto; white-space: pre-wrap; word-break: break-word;
      margin: 0;
    }

    .env-list { display: flex; flex-direction: column; gap: 10px; }
    .env-field { display: flex; flex-direction: column; gap: 4px; }
    .env-field-label {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.66rem;
      color: rgba(255,255,255,0.78);
    }
    .env-field-label code {
      background: rgba(0,229,255,0.08);
      color: var(--ps-accent, #00E5FF);
      padding: 1px 6px; border-radius: 4px;
    }
    .env-req { color: #fbbf24; font-weight: 700; }
    .env-auto-mini {
      font-size: 0.55rem; padding: 1px 5px;
      background: rgba(52,211,153,0.1);
      color: #34d399; border-radius: 999px;
      border: 1px solid rgba(52,211,153,0.28);
    }
    .env-desc {
      font-size: 0.66rem; color: rgba(255,255,255,0.5); line-height: 1.4;
    }
    /* .input-field removed — the lone env-value field now uses hlmInput (Spartan). */

    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; }
    @media (max-width: 540px) { .meta-grid { grid-template-columns: 1fr; } }
    .meta-cell {
      display: flex; flex-direction: column; gap: 2px;
      padding: 0.5rem 0.6rem;
      background: rgba(255,255,255,0.03);
      border-radius: 6px; min-width: 0;
    }
    .meta-cell-k {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.55rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: rgba(255,255,255,0.45);
    }
    .meta-cell-v {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.68rem; color: rgba(255,255,255,0.82);
      overflow: hidden; text-overflow: ellipsis;
    }

    .btn-primary, .btn-ghost, .btn-tiny, .btn-danger-ghost {
      display: inline-flex; align-items: center; gap: 6px;
      border-radius: var(--ps-radius-sm, 8px);
      cursor: pointer; font-weight: 600;
      transition: background 140ms ease, transform 140ms ease, border-color 140ms ease;
    }
    .btn-primary {
      padding: 0.5rem 0.95rem;
      background: rgba(0,229,255,0.12);
      color: var(--ps-accent, #00E5FF);
      border: 1px solid rgba(0,229,255,0.35);
      font-size: 0.74rem;
    }
    .btn-primary:hover:not(:disabled) { background: rgba(0,229,255,0.2); transform: translateY(-1px); border-color: rgba(0,229,255,0.55); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-ghost {
      padding: 0.45rem 0.85rem;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.78);
      border: 1px solid rgba(255,255,255,0.1);
      font-size: 0.72rem;
    }
    .btn-ghost:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.16); }
    .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-tiny {
      padding: 4px 9px;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.7);
      border: 1px solid rgba(255,255,255,0.08);
      font-size: 0.62rem;
    }
    .btn-tiny:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: #fff; }
    .btn-tiny:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-danger-ghost {
      padding: 0.45rem 0.85rem;
      background: transparent;
      color: #fca5a5;
      border: 1px solid rgba(248,113,113,0.28);
      font-size: 0.72rem;
    }
    .btn-danger-ghost:hover:not(:disabled) { background: rgba(248,113,113,0.14); color: #fecaca; border-color: rgba(248,113,113,0.5); }
    .btn-danger-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary:focus-visible, .btn-ghost:focus-visible, .btn-tiny:focus-visible {
      outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px;
    }
    .btn-danger-ghost:focus-visible { outline: 2px solid #fca5a5; outline-offset: 2px; }

    .notice {
      display: flex; gap: 0.6rem; align-items: flex-start;
      font-size: 0.82rem; line-height: 1.5;
      padding: 0.85rem 1rem;
    }
    .notice strong { display: block; }
    .notice-red {
      background: rgba(248,113,113,0.06);
      border-color: rgba(248,113,113,0.3);
      color: #fecaca;
    }
    .notice-red strong { color: #fca5a5; }
  `],
})
export class AppInstanceDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirmSvc = inject(ConfirmService);

  @ViewChild('logsBox') private logsBox?: ElementRef<HTMLPreElement>;

  instanceId = signal<string>('');
  instance = signal<AppInstance | null>(null);
  catalogApp = computed<CatalogApp | null>(() => {
    const i = this.instance();
    return i ? resolveApp(i.app_id) : null;
  });

  logs = signal<readonly LogLine[]>([]);
  loading = signal<boolean>(false);
  loadFailed = signal<boolean>(false);
  /** True on a genuine 404 — renders the branded "Instance not found." notice
   *  (with the id), NOT the retryable network-error card. The worker returns
   *  status 404 "app_instance not found" for unknown ids; the handler comment
   *  claimed to distinguish this case but routed EVERY error to the retry card
   *  (chaos-16 journey 2026-08-19). */
  notFound = signal<boolean>(false);
  /** Worker request_id from a failed instance load → copyable support reference on the error card. */
  loadErrorRef = signal('');
  logsLoading = signal<boolean>(false);
  busy = signal<boolean>(false);

  /** Pre-formatted log block — kept off the template to preserve whitespace. */
  joinedLogs = computed<string>(() => this.logs().map((l) => this.formatLog(l)).join(''));

  envValues: Record<string, string> = {};

  private pollHandle?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.instanceId.set(id);
    this.load();
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  load(): void {
    const id = this.instanceId();
    if (!id) return;
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    this.loadErrorRef.set('');
    this.api.get<{ instance: Record<string, unknown> }>(`/apps/instances/${id}`).subscribe({
      next: (r) => {
        const inst = r.instance ? adaptInstance(r.instance) : null;
        this.instance.set(inst);
        this.loading.set(false);
        this.loadFailed.set(false);
        this.maybeStartPolling();
        this.refreshLogs();
        // Pre-fill env editor from server-side keys when present.
        if (inst?.env_keys) {
          for (const k of inst.env_keys) {
            if (!(k in this.envValues)) this.envValues[k] = '';
          }
        }
      },
      error: (err) => {
        this.loading.set(false);
        this.instance.set(null);
        // Distinguish a network/server failure from a genuine not-found so
        // the user sees a retry affordance instead of a dead "not found".
        // A real 404 (worker "app_instance not found") is NOT a retryable
        // failure — surface the branded notice with the id.
        const status = (err as { status?: number } | undefined)?.status;
        if (status === 404) {
          this.notFound.set(true);
        } else {
          this.loadFailed.set(true);
          this.loadErrorRef.set(this.requestIdFrom(err));
        }
      },
    });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: unknown): string {
    return ((e as { error?: { error?: { request_id?: string } } } | undefined)?.error?.error?.request_id) ?? '';
  }

  refreshLogs(): void {
    const id = this.instanceId();
    if (!id) return;
    this.logsLoading.set(true);
    this.api.get<{ lines: LogLine[] }>(`/apps/instances/${id}/logs`).subscribe({
      next: (r) => {
        // Stale-route guard: a shapeless 200 (marketing HTML / `{}`) can bypass
        // ApiService's 2xx→404 remap. A non-array `lines` would either fake-empty
        // the log box or crash the `@for (l of logs())` render — so on a stale
        // tick keep the prior buffer (logs poll every 5s) and never set a non-array.
        if (r && Array.isArray(r.lines)) {
          this.logs.set(r.lines);
        } else {
          console.warn('[apps] logs response had no array — kept prior buffer');
        }
        this.logsLoading.set(false);
        requestAnimationFrame(() => {
          if (this.logsBox?.nativeElement) {
            const el = this.logsBox.nativeElement;
            el.scrollTop = el.scrollHeight;
          }
        });
      },
      error: () => this.logsLoading.set(false),
    });
  }

  private maybeStartPolling(): void {
    const status = this.instance()?.status;
    const shouldPoll = status === 'provisioning' || status === 'running';
    if (shouldPoll && !this.pollHandle) {
      this.pollHandle = setInterval(() => { this.refreshLogs(); this.load(); }, 5_000);
    } else if (!shouldPoll && this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  pollingLabel(): string {
    return this.pollHandle ? 'polling 5s' : 'paused';
  }

  statusLabel(s: InstanceStatus): string { return STATUS_META[s].label; }
  statusColor(s: InstanceStatus): string { return STATUS_META[s].color; }

  formatLog(l: LogLine): string {
    const ts = l.ts ?? '';
    const lvl = (l.level ?? 'info').toUpperCase().padEnd(5, ' ');
    return `${ts}  ${lvl}  ${l.msg}\n`;
  }

  restart(): void {
    const i = this.instance(); if (!i || this.busy()) return;
    this.busy.set(true);
    this.api.post(`/apps/instances/${i.id}/restart`, {}).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Restart triggered'); this.load(); },
      error: () => this.busy.set(false),
    });
  }

  async stop(): Promise<void> {
    const i = this.instance(); if (!i || this.busy()) return;
    // Stopping takes the live service offline until someone restarts it — confirm
    // so a misclick (Stop sits beside Destroy) never drops a customer-facing app.
    // Reversible → non-danger. Mirrors the list-view stopInstance + destroy.
    const ok = await this.confirmSvc.confirm({
      title: 'Stop instance',
      message: `Stop "${this.catalogApp()?.name ?? i.app_id}"? It goes offline until you restart it — visitors will see it as unavailable.`,
      confirmLabel: 'Stop',
      danger: false,
    });
    if (!ok) return;
    this.busy.set(true);
    this.api.post(`/apps/instances/${i.id}/stop`, {}).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Stopped'); this.load(); },
      error: () => this.busy.set(false),
    });
  }

  async destroy(): Promise<void> {
    const i = this.instance(); if (!i || this.busy()) return;
    // Modal confirm (not an auto-dismissing toast) — destroying releases the
    // container, all data, AND the subdomain irreversibly. Matches the list
    // view's deleteInstance + the one-dialog-primitive rule (focus-trapped,
    // deliberate, can't be missed).
    const ok = await this.confirmSvc.confirm({
      title: 'Destroy instance',
      message: `Destroy "${this.catalogApp()?.name ?? i.app_id}"? Its container, all data, and the subdomain are released — this cannot be undone.`,
      confirmLabel: 'Destroy',
      danger: true,
    });
    if (!ok) return;
    this.performDestroy(i.id);
  }

  private performDestroy(id: string): void {
    this.busy.set(true);
    this.api.delete(`/apps/instances/${id}`).subscribe({
      next: () => {
        this.busy.set(false);
        this.toast.success('Instance destroyed');
        this.router.navigate(['/admin/apps/instances']);
      },
      error: () => this.busy.set(false),
    });
  }

  /**
   * Catalog env vars the USER must supply: required, NOT auto-resolved by the
   * platform, NO default, and currently blank. Saving these empty would restart
   * the container into a broken boot. Auto/defaulted required vars are filled by
   * the worker, so they never count. Re-evals every CD (envValues is reactive
   * via ngModel) so the button + hint stay live as the user types.
   */
  requiredEnvMissing(): string[] {
    const app = this.catalogApp();
    if (!app) return [];
    return app.env
      .filter((e) => e.required && !e.auto && e.default == null && !(this.envValues[e.key] ?? '').trim())
      .map((e) => e.key);
  }

  saveEnv(): void {
    const i = this.instance(); if (!i || this.busy()) return;
    const missing = this.requiredEnvMissing();
    if (missing.length) {
      this.toast.error(`Fill required env before restart: ${missing.join(', ')}`);
      return;
    }
    this.busy.set(true);
    this.api.patch(`/apps/instances/${i.id}/env`, { env_overrides: this.envValues }).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Env saved — restarting container'); this.load(); },
      error: () => this.busy.set(false),
    });
  }
}
