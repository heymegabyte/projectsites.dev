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
import { DatePipe, NgTemplateOutlet } from '@angular/common';
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
import { AppSecretInputComponent } from './app-secret-input.component';
import { DomainManagerComponent } from './domain-manager.component';

type InstanceStatus = 'provisioning' | 'starting' | 'running' | 'error' | 'stopped';

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
  /** Decrypted env values (admin-only, from the detail GET) — loaded MASKED into the editor so a
   *  persisted secret shows as dots (unmaskable), never as an empty field. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * A group of instances of the SAME app (e.g. every Payload CMS instance), rendered
 * as ONE encapsulated card with an inner table of instances + per-instance actions.
 * Grouping keeps the list scannable when an org runs several of the same app.
 */
interface InstanceGroup {
  readonly app_id: string;
  readonly name: string;
  readonly glyph: string;
  readonly instances: readonly AppInstance[];
  readonly runningCount: number;
  readonly totalMonthlyUsd: number;
  readonly anyProvisioning: boolean;
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
        <!-- Aggregate strip — totals across every group. -->
        <div class="agg-strip" appReveal>
          <span class="agg-cell"><b class="agg-num">{{ instances().length }}</b> instance{{ instances().length === 1 ? '' : 's' }}</span>
          <span class="agg-cell agg-groups"><b class="agg-num">{{ groups().length }}</b> app{{ groups().length === 1 ? '' : 's' }}</span>
          @if (runningCount() > 0) {
            <span class="agg-cell agg-running"><span class="agg-run-dot" aria-hidden="true"></span><b class="agg-num">{{ runningCount() }}</b> running</span>
          }
          @if (totalMonthlyUsd() > 0) {
            <span class="agg-cell agg-cost"><b class="agg-num">{{ '~$' + totalMonthlyUsd() }}</b><span class="cost-unit">/mo est.</span></span>
          }
        </div>

        <!-- One encapsulated card PER APP; instances of the same app are grouped
             into an inner table with per-instance action buttons (no popup menu →
             nothing can be clipped by the scroll container). -->
        <div class="group-list">
          @for (group of groups(); track group.app_id) {
            <section class="group-card" appReveal [attr.data-testid]="'apps-group-' + group.app_id">
              <span class="group-accent" aria-hidden="true"></span>
              <header class="group-head">
                <div class="group-glyph" aria-hidden="true">{{ group.glyph }}</div>
                <div class="group-headmain">
                  <h3 class="group-name">
                    <span class="group-name-text">{{ group.name }}</span>
                    <span class="group-count" [attr.aria-label]="group.instances.length + ' instances'">{{ group.instances.length }}</span>
                  </h3>
                  <div class="group-sub">
                    @if (group.runningCount > 0) {
                      <span class="group-run"><span class="group-run-dot" aria-hidden="true"></span>{{ group.runningCount }} running</span>
                    }
                    @if (group.instances.length - group.runningCount > 0) {
                      <span class="group-idle">{{ group.instances.length - group.runningCount }} idle</span>
                    }
                    @if (group.totalMonthlyUsd > 0) {
                      <span class="group-cost">{{ '~$' + group.totalMonthlyUsd }}<span class="cost-unit">/mo</span></span>
                    }
                  </div>
                </div>
                <a class="btn-deploy-another"
                   [routerLink]="['/admin/apps', group.app_id]"
                   [attr.aria-label]="'Deploy another ' + group.name">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                  <span class="dep-label">Deploy another</span>
                </a>
              </header>

              <div class="inst-table" role="table" [attr.aria-label]="group.name + ' instances'">
                @for (inst of group.instances; track inst.id) {
                  <div class="inst-line" role="row" [attr.data-testid]="'apps-instance-' + inst.id" [attr.data-status]="inst.status">
                    <a class="inst-host" role="cell"
                       [href]="hostUrl(inst)" target="_blank" rel="noopener noreferrer"
                       [attr.aria-label]="'Open ' + inst.hostname">
                      <span class="host-text">{{ inst.hostname }}</span>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
                    </a>
                    <span class="status-pill" role="cell" [attr.data-status]="inst.status" [style.--pill-color]="statusColor(inst.status)">
                      <span class="status-dot" aria-hidden="true"></span>
                      {{ statusLabel(inst.status) }}
                    </span>
                    <span class="inst-cost" role="cell">
                      @if (inst.costEstimate; as ce) {
                        <span [attr.aria-label]="'Estimated cost ' + ce.monthlyUsd + ' dollars per month'"
                              title="Live estimate from running state + provisioned infra (not exact billing)">{{ '~$' + ce.monthlyUsd }}<span class="cost-unit" aria-hidden="true">/mo</span></span>
                      }
                    </span>
                    <span class="inst-activity" role="cell">
                      @if (inst.last_activity_at) { {{ inst.last_activity_at | date:'short' }} }
                      @else { {{ inst.created_at | date:'short' }} }
                    </span>
                    <span class="inst-actions" role="cell">
                      <a class="act-btn" [routerLink]="['/admin/apps/instances', inst.id]"
                         title="Open detail" [attr.aria-label]="'Open detail for ' + inst.hostname">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                      </a>
                      @if (inst.status === 'running' || inst.status === 'error') {
                        <button class="act-btn" type="button" [disabled]="acting() === inst.id"
                                (click)="restartInstance(inst)" title="Restart" [attr.aria-label]="'Restart ' + inst.hostname">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/></svg>
                        </button>
                      }
                      @if (inst.status === 'running') {
                        <button class="act-btn" type="button" [disabled]="acting() === inst.id"
                                (click)="stopInstance(inst)" title="Stop" [attr.aria-label]="'Stop ' + inst.hostname">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
                        </button>
                      }
                      <button class="act-btn act-danger" type="button" [disabled]="acting() === inst.id"
                              (click)="deleteInstance(inst)" title="Delete" [attr.aria-label]="'Delete ' + inst.hostname">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                      </button>
                    </span>
                    @if (inst.status === 'error' && inst.last_error) {
                      <span class="inst-error-line" role="cell" [title]="inst.last_error"
                            [attr.aria-label]="'Last error: ' + inst.last_error">⚠ {{ inst.last_error }}</span>
                    }
                  </div>
                }
              </div>
            </section>
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

    /* ─── Aggregate strip + grouped instance cards (Brian 2026-09-27) ─── */
    .agg-strip {
      display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 1.1rem;
      padding: 0.55rem 0.95rem;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 4%, rgba(13,13,40,0.5));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.68rem; color: rgba(255,255,255,0.55);
    }
    .agg-cell { display: inline-flex; align-items: center; gap: 6px; }
    .agg-num { color: #fff; font-weight: 700; }
    .agg-running { color: #6ee7b7; }
    .agg-run-dot { width: 6px; height: 6px; border-radius: 50%; background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.7); }
    .agg-cost { color: var(--ps-accent, #00E5FF); }
    .cost-unit { opacity: 0.6; margin-left: 1px; font-weight: 400; }

    .group-list { display: flex; flex-direction: column; gap: 14px; }
    .group-card {
      position: relative; overflow: hidden;
      background:
        linear-gradient(180deg, color-mix(in oklch, var(--ps-accent,#00E5FF) 5%, transparent), transparent 120px),
        var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: var(--ps-radius-xl, 22px);
      box-shadow: 0 18px 44px -30px rgba(0,0,0,0.75);
      transition: border-color 200ms ease, box-shadow 200ms ease;
    }
    .group-card:hover {
      border-color: color-mix(in oklch, var(--ps-accent,#00E5FF) 26%, transparent);
      box-shadow: 0 22px 60px -28px rgba(0,0,0,0.8), 0 0 0 1px color-mix(in oklch, var(--ps-accent,#00E5FF) 12%, transparent);
    }
    .group-accent {
      position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, transparent, color-mix(in oklch, var(--ps-accent,#00E5FF) 70%, transparent), rgba(124,58,237,0.6), transparent);
      opacity: 0.75;
    }
    @media (prefers-reduced-motion: reduce) { .group-card { transition: none; } }

    .group-head {
      display: flex; align-items: center; gap: 0.9rem;
      padding: 1rem 1.15rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .group-glyph {
      flex-shrink: 0; width: 46px; height: 46px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1.5rem; line-height: 1;
      background: color-mix(in oklch, var(--ps-accent,#00E5FF) 9%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent,#00E5FF) 20%, transparent);
      border-radius: var(--ps-radius-sm, 12px);
    }
    .group-headmain { min-width: 0; flex: 1; }
    .group-name {
      display: flex; align-items: center; gap: 8px; margin: 0;
      font-family: 'Sora', system-ui, sans-serif; font-weight: 700;
      font-size: 0.98rem; letter-spacing: -0.01em; color: var(--ps-ink, #fff);
    }
    .group-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .group-count {
      flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px; height: 20px; padding: 0 7px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.66rem; font-weight: 700;
      color: var(--ps-accent,#00E5FF);
      background: color-mix(in oklch, var(--ps-accent,#00E5FF) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent,#00E5FF) 30%, transparent);
      border-radius: 999px;
    }
    .group-sub {
      display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 3px;
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.64rem;
    }
    .group-run { display: inline-flex; align-items: center; gap: 5px; color: #6ee7b7; }
    .group-run-dot { width: 5px; height: 5px; border-radius: 50%; background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.7); }
    .group-idle { color: rgba(255,255,255,0.4); }
    .group-cost { color: rgba(255,255,255,0.55); }

    .btn-deploy-another {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0.4rem 0.75rem; border-radius: var(--ps-radius-sm, 8px);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.7);
      border: 1px solid rgba(255,255,255,0.1);
      font-family: 'Sora', system-ui, sans-serif; font-size: 0.68rem; font-weight: 600;
      text-decoration: none; white-space: nowrap;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease;
    }
    .btn-deploy-another:hover {
      background: rgba(0,229,255,0.12); color: var(--ps-accent,#00E5FF);
      border-color: rgba(0,229,255,0.4); transform: translateY(-1px);
    }
    .btn-deploy-another:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .btn-deploy-another:hover { transform: none; } }
    @media (max-width: 620px) { .btn-deploy-another .dep-label { display: none; } }

    .inst-table { display: flex; flex-direction: column; padding: 4px 6px; }
    .inst-line {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) auto auto auto auto;
      align-items: center; gap: 0.75rem;
      padding: 0.6rem 0.7rem;
      border-radius: var(--ps-radius-sm, 10px);
      transition: background 140ms ease;
    }
    .inst-line + .inst-line { border-top: 1px solid rgba(255,255,255,0.045); }
    .inst-line:hover { background: color-mix(in oklch, var(--ps-accent,#00E5FF) 4%, transparent); }
    .inst-line .inst-host { margin-top: 0; min-width: 0; }
    .host-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inst-cost {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.66rem; color: rgba(255,255,255,0.55); white-space: nowrap; text-align: right;
    }
    .inst-actions { display: inline-flex; align-items: center; gap: 4px; justify-self: end; }
    .act-btn {
      width: 30px; height: 30px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px; color: rgba(255,255,255,0.6); cursor: pointer; text-decoration: none;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .act-btn:hover:not(:disabled) { background: rgba(0,229,255,0.12); color: var(--ps-accent,#00E5FF); border-color: rgba(0,229,255,0.35); }
    .act-btn:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .act-btn:disabled { opacity: 0.4; cursor: progress; }
    .act-danger:hover:not(:disabled) { background: rgba(248,113,113,0.14); color: #fca5a5; border-color: rgba(248,113,113,0.4); }
    .inst-error-line {
      grid-column: 1 / -1;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.64rem; color: #fca5a5;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-top: 2px;
    }
    @media (max-width: 760px) {
      .inst-line {
        grid-template-columns: 1fr auto;
        grid-template-areas: "host actions" "status cost";
        row-gap: 8px;
      }
      .inst-line .inst-host { grid-area: host; }
      .inst-line .inst-actions { grid-area: actions; }
      .inst-line .status-pill { grid-area: status; justify-self: start; }
      .inst-line .inst-cost { grid-area: cost; justify-self: end; text-align: right; }
      .inst-line .inst-activity { display: none; }
      .inst-error-line { grid-column: 1 / -1; }
    }
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
  /** Total live monthly-cost estimate across every instance (0 when none report). */
  totalMonthlyUsd = computed(() =>
    Math.round(this.instances().reduce((sum, i) => sum + (i.costEstimate?.monthlyUsd ?? 0), 0)),
  );
  /**
   * Instances grouped by app — the list renders ONE encapsulated card per group
   * (e.g. all Payload CMS instances in a single entry with an inner table + per-
   * instance actions). Sorted by instance count desc, then name, so the busiest
   * apps lead. (Brian 2026-09-27.)
   */
  groups = computed<readonly InstanceGroup[]>(() => {
    const byApp = new Map<string, AppInstance[]>();
    for (const inst of this.instances()) {
      const arr = byApp.get(inst.app_id);
      if (arr) arr.push(inst);
      else byApp.set(inst.app_id, [inst]);
    }
    return [...byApp.entries()]
      .map(([app_id, insts]) => ({
        app_id,
        name: resolveApp(app_id)?.name ?? app_id,
        glyph: resolveApp(app_id)?.glyph ?? '📦',
        instances: insts,
        runningCount: insts.filter((i) => i.status === 'running').length,
        totalMonthlyUsd: Math.round(insts.reduce((s, i) => s + (i.costEstimate?.monthlyUsd ?? 0), 0)),
        anyProvisioning: insts.some((i) => i.status === 'provisioning'),
      }))
      .sort((a, b) => b.instances.length - a.instances.length || a.name.localeCompare(b.name));
  });

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
      message: `Delete instance "${this.nameFor(inst)}"? This destroys ${resolveApp(inst.app_id)?.image?.startsWith('cf-native:') ? 'its Worker, D1 database, and R2 bucket' : 'its container and data'} — this cannot be undone.`,
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
  imports: [DatePipe, NgTemplateOutlet, FormsModule, RouterLink, RevealDirective, HlmInputDirective, ErrorCardComponent, AppSecretInputComponent, DomainManagerComponent],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">

      <a class="back-link" routerLink="/admin/apps/instances">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        <span>All instances</span>
      </a>

      @if (instance(); as i) {
        <header class="detail-head" appReveal>
          <div class="head-main">
            <div class="head-glyph" aria-hidden="true">
              @if (catalogApp()?.logo; as lg) {
                <img class="head-logo" [src]="lg" [alt]="(catalogApp()?.name ?? '') + ' logo'" loading="eager" decoding="async" />
              } @else {
                {{ catalogApp()?.glyph ?? '📦' }}
              }
            </div>
            <div class="min-w-0 flex-1">
              <div class="kicker">{{ catalogApp()?.category ?? 'app' }}</div>
              <h2 class="section-h text-2xl font-bold text-white m-0 mt-1">{{ catalogApp()?.name ?? i.app_id }}</h2>
              <div class="inst-host-row">
                <app-domain-manager
                  [instanceId]="i.id"
                  [appId]="i.app_id"
                  [host]="i.hostname"
                  [suffix]="hostSuffix(i.hostname)"
                  (changed)="load()" />
                <a class="inst-host-open" [href]="'https://' + i.hostname" target="_blank" rel="noopener noreferrer"
                   [attr.aria-label]="'Open ' + i.hostname + ' in a new tab'">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
                </a>
              </div>
            </div>
            <span class="status-pill" [attr.data-status]="i.status" [style.--pill-color]="statusColor(i.status)">
              <span class="status-dot" aria-hidden="true"></span>
              {{ statusLabel(i.status) }}
            </span>
          </div>

          <div class="action-row">
            @if (i.status === 'stopped') {
              <!-- Stop↔Start toggle: a stopped instance shows Start (not Restart). -->
              <button class="btn-primary" type="button" (click)="start()" [disabled]="busy()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                Start
              </button>
            } @else if (i.status === 'running' || i.status === 'error') {
              <button class="btn-ghost" type="button" (click)="restart()" [disabled]="busy()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/></svg>
                Restart
              </button>
            }
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
            @if (busy()) {
              <span class="action-progress" role="status" aria-live="polite">
                <span class="act-spinner" aria-hidden="true"></span>{{ busyLabel() || 'Working…' }}
              </span>
            }
          </div>
        </header>

        <div class="grid-2col">
          @if (catalogApp()?.image?.startsWith('cf-native:')) {
            <!-- ─── RUNTIME (CF-native edge Worker) ─── -->
            <!-- CF-native apps run as an edge Worker (D1 + R2 + Workers-for-Platforms),
                 NOT a container — there is no container log stream, so instead of a dead
                 empty "Logs" terminal we show the provisioning→live lifecycle + the live
                 URL. Status polls via load() until running (see maybeStartPolling). -->
            <section class="card" appReveal [attr.aria-busy]="i.status === 'provisioning'">
              <header class="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <h3 class="card-h m-0">Runtime</h3>
                <span class="status-pill" [attr.data-status]="i.status" [style.--pill-color]="statusColor(i.status)">
                  <span class="status-dot" aria-hidden="true"></span>{{ statusLabel(i.status) }}
                </span>
              </header>
              <ul class="text-[0.85rem] leading-relaxed list-none p-0 m-0 space-y-2" aria-live="polite">
                <li class="flex items-center gap-2" [class.text-text-secondary]="i.status === 'provisioning'">
                  <ng-container *ngTemplateOutlet="stepIcon; context: { $implicit: i.status === 'error' ? 'failed' : (i.status === 'provisioning' ? 'processing' : 'success') }" /> Provisioned D1 database + R2 bucket
                </li>
                <li class="flex items-center gap-2" [class.text-text-secondary]="i.status !== 'running'">
                  <ng-container *ngTemplateOutlet="stepIcon; context: { $implicit: i.status === 'running' ? 'success' : (i.status === 'error' ? 'failed' : 'pending') }" /> Deployed Worker to the edge network
                </li>
                <li class="flex items-center gap-2" [class.text-text-secondary]="i.status !== 'running'">
                  <ng-container *ngTemplateOutlet="stepIcon; context: { $implicit: i.status === 'running' ? 'success' : (i.status === 'error' ? 'failed' : 'pending') }" /> Live on the edge
                </li>
              </ul>

              <!-- Shared, equi-spaced status-icon set for the provisioning timeline.
                   One visual family (18px inline SVG, stroke=currentColor) in a
                   fixed-width leading column so every step label lines up. States:
                   pending · processing · failed · success. -->
              <ng-template #stepIcon let-state>
                <span class="step-ico" [attr.data-state]="state" role="img"
                      [attr.aria-label]="state === 'success' ? 'completed' : (state === 'processing' ? 'in progress' : (state === 'failed' ? 'failed' : 'pending'))">
                  @switch (state) {
                    @case ('success') {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.4 2.4 4.6-5.2"/></svg>
                    }
                    @case ('processing') {
                      <span class="step-spinner" aria-hidden="true"></span>
                    }
                    @case ('failed') {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/></svg>
                    }
                    @default {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>
                    }
                  }
                </span>
              </ng-template>
              @if (i.status === 'provisioning') {
                <p class="provision-note" role="status" aria-live="polite">
                  <span class="act-spinner" aria-hidden="true"></span>
                  Generally accessible in under a minute — this page updates automatically the moment it's live.
                </p>
              }
              @if (i.status === 'running') {
                <a class="btn-ghost mt-3" [href]="'https://' + i.hostname" target="_blank" rel="noopener noreferrer">
                  Open {{ i.hostname }}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>
                </a>
              } @else if (i.status === 'error') {
                <p class="text-[0.8rem] mt-3 m-0" style="color:#f87171">Provisioning failed — destroy this instance and relaunch.</p>
              }
              <p class="text-[0.68rem] text-text-secondary mt-3 mb-0">
                Runs as a Cloudflare Worker on the edge (Workers for Platforms) — no container, so there's no container log stream.
              </p>
            </section>
          } @else {
            <!-- ─── LOGS ─── (container apps) -->
            <section class="card" appReveal [attr.aria-busy]="logsLoading()">
              <header class="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <h3 class="card-h m-0">Logs</h3>
                <div class="flex items-center gap-2">
                  <span class="text-[0.62rem] text-text-secondary font-mono" aria-live="polite">
                    {{ logs().length }} lines · {{ pollingLabel() }}
                  </span>
                  <button class="btn-tiny" type="button" (click)="refreshLogs()" [disabled]="logsLoading()" [attr.aria-label]="logsLoading() ? 'Refreshing logs' : 'Refresh logs'">
                    <span class="inline-block text-center min-w-[11ch]">{{ logsLoading() ? 'Refreshing…' : 'Refresh' }}</span>
                  </button>
                </div>
              </header>
              @if (logs().length === 0) {
                <pre #logsBox class="logs-box logs-box--empty" aria-live="polite">No logs yet. Provisioning… check back in a few seconds.</pre>
              } @else {
                <pre #logsBox class="logs-box" aria-live="polite">{{ joinedLogs() }}</pre>
              }
            </section>
          }

          <!-- ─── ENV EDITOR ─── -->
          <aside class="card" appReveal>
            <h3 class="card-h">Environment variables</h3>
            @if (!catalogApp()) {
              <p class="text-[0.78rem] text-text-secondary m-0">Catalog entry unavailable — env editor disabled.</p>
            } @else {
              <div class="env-list">
                @for (e of catalogApp()!.env; track e.key) {
                  <div class="env-field">
                    <span class="env-field-label">
                      <code>{{ e.key }}</code>
                      @if (e.required) { <span class="env-req">*</span> }
                      @if (e.auto) { <span class="env-auto-mini">auto</span> }
                    </span>
                    @if (e.auto && !isEditingAuto(e.key) && !(envValues[e.key] || '').trim()) {
                      <!-- Auto-generated var with NO stored value — click to set one the instance
                           uses on its next reload. (A stored value renders masked below instead.) -->
                      <button type="button" class="env-auto-edit" (click)="startEditAuto(e.key)"
                              [attr.data-testid]="'env-auto-' + e.key"
                              [attr.aria-label]="'Override ' + e.key + ' with a custom value'">
                        <span>Auto-generated — click to override</span>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                      </button>
                    } @else {
                      <!-- Loaded MASKED (dots) — real value present; eye reveals, edits apply on reload. -->
                      <app-secret-input
                        [value]="envValues[e.key] || ''"
                        (valueChange)="envValues[e.key] = $event"
                        (valueBlur)="e.auto && onAutoBlur(e.key)"
                        [placeholder]="e.auto ? 'new value applied on next reload' : (e.default ?? 'set value')"
                        [ariaLabel]="e.key"
                        [testid]="'env-input-' + e.key" />
                    }
                    <span class="env-desc">{{ e.description }}</span>
                  </div>
                }
              </div>

              <!-- Owner-added custom env vars — the ONLY env editor for CF-native apps (no fixed
                   catalog env), and extra vars for container apps. Saved keys inject into the
                   Worker/container on save. -->
              <div class="env-custom">
                @if (customEnv().length === 0) {
                  <p class="text-[0.74rem] text-text-secondary m-0">No custom variables yet.</p>
                }
                @for (row of customEnv(); track $index) {
                  <div class="env-custom-row">
                    <input type="text" hlmInput class="font-mono text-xs" placeholder="KEY"
                           [ngModel]="row.key" (ngModelChange)="setEnvKey($index, $event)"
                           [attr.aria-label]="'Env var name ' + ($index + 1)"
                           [attr.data-testid]="'env-custom-key-' + $index" />
                    <app-secret-input class="env-custom-val-wrap"
                           [value]="row.value"
                           (valueChange)="setEnvValue($index, $event)"
                           placeholder="value"
                           [ariaLabel]="'Env var value ' + ($index + 1)"
                           [testid]="'env-custom-val-' + $index" />
                    <button class="btn-tiny env-remove" type="button" (click)="removeEnvRow($index)"
                            [attr.aria-label]="'Remove env var ' + ($index + 1)">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                  </div>
                }
                <button class="btn-ghost btn-add-env mt-2" type="button" (click)="addEnvRow()" data-testid="env-add-row">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                  Add variable
                </button>
                @if (invalidEnvKeys()) {
                  <p class="text-[0.72rem] m-0 mt-2" style="color: var(--ps-warning, #ffb454);" role="alert">
                    Names must start with a letter or underscore (A–Z, 0–9, _ only).
                  </p>
                }
              </div>

              @if (requiredEnvMissing().length) {
                <p class="text-[0.72rem] m-0 mt-2" style="color: var(--ps-warning, #ffb454);" role="alert" data-testid="env-required-hint">
                  Required before restart: {{ requiredEnvMissing().join(', ') }}
                </p>
              }
              <button class="btn-primary mt-3" type="button" (click)="saveEnv()"
                      [disabled]="busy() || requiredEnvMissing().length > 0 || invalidEnvKeys()"
                      [attr.aria-disabled]="busy() || requiredEnvMissing().length > 0 || invalidEnvKeys()">
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
    .inst-host-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .inst-host-open {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
      color: var(--ps-accent, #00E5FF); background: rgba(0,229,255,0.06); border: 1px solid rgba(0,229,255,0.2);
    }
    .inst-host-open:hover { background: rgba(0,229,255,0.14); }
    .inst-host-open:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .head-glyph {
      flex-shrink: 0;
      width: 64px; height: 64px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 2.2rem; line-height: 1;
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 24%, transparent);
      border-radius: var(--ps-radius-sm, 12px);
      overflow: hidden;
    }
    .head-logo { width: 60%; height: 60%; object-fit: contain; display: block; }
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

    .action-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .action-progress {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.68rem; color: var(--ps-accent, #00E5FF);
      padding-left: 4px;
    }
    .act-spinner {
      width: 11px; height: 11px; flex-shrink: 0;
      border: 2px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 35%, transparent);
      border-top-color: var(--ps-accent, #00E5FF);
      border-radius: 50%;
      animation: act-spin 700ms linear infinite;
    }
    @keyframes act-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .act-spinner { animation: none; } }

    /* Provisioning-timeline status icons — single visual family, fixed-width
       leading column so every step label lines up (equi-spaced). */
    .step-ico {
      flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
    }
    .step-ico svg { width: 18px; height: 18px; display: block; }
    .step-ico[data-state="success"] { color: var(--ps-accent, #00E5FF); }
    .step-ico[data-state="failed"] { color: var(--ps-danger, #f87171); }
    .step-ico[data-state="pending"] { color: var(--ps-text-muted, rgba(255,255,255,0.6)); }
    .step-ico[data-state="processing"] { color: var(--ps-accent, #00E5FF); }
    .step-spinner {
      width: 16px; height: 16px; flex-shrink: 0;
      border: 2px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 30%, transparent);
      border-top-color: var(--ps-accent, #00E5FF);
      border-radius: 50%;
      animation: act-spin 700ms linear infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .step-spinner { animation: none; }
    }
    .provision-note {
      display: flex; align-items: center; gap: 8px;
      margin: 0.75rem 0 0 0;
      font-size: 0.74rem; line-height: 1.4;
      color: var(--ps-accent, #00E5FF);
    }

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
    .env-auto-edit {
      display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
      padding: 0.42rem 0.7rem; cursor: pointer;
      background: rgba(52,211,153,0.08); border: 1px dashed rgba(52,211,153,0.4);
      border-radius: var(--ps-radius-sm, 8px);
      color: #6ee7b7; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.68rem;
      transition: background 140ms ease, border-color 140ms ease;
    }
    .env-auto-edit:hover { background: rgba(52,211,153,0.16); border-color: rgba(52,211,153,0.6); }
    .env-auto-edit:focus-visible { outline: var(--ps-ring-focus, 2px solid #00E5FF); outline-offset: 2px; }
    .env-custom-val-wrap { min-width: 0; }
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

    .env-custom { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .env-custom-row {
      display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.3fr) 30px;
      gap: 6px; align-items: center;
    }
    .env-remove {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; padding: 0;
      color: rgba(255,255,255,0.55);
    }
    .env-remove:hover { color: #fca5a5; }
    .btn-add-env { align-self: flex-start; }

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
  /** Human progress label shown next to the grayed-out action buttons (Starting…/Stopping…/…). */
  busyLabel = signal<string>('');

  /** Pre-formatted log block — kept off the template to preserve whitespace. */
  joinedLogs = computed<string>(() => this.logs().map((l) => this.formatLog(l)).join(''));

  envValues: Record<string, string> = {};
  /** Owner-added custom env vars (key+value rows) — for apps with no fixed catalog env
   *  (e.g. CF-native Payload). Merged into env_overrides on save. */
  customEnv = signal<Array<{ key: string; value: string }>>([]);

  private pollHandle?: ReturnType<typeof setInterval>;

  addEnvRow(): void {
    this.customEnv.update((rows) => [...rows, { key: '', value: '' }]);
  }
  removeEnvRow(idx: number): void {
    this.customEnv.update((rows) => rows.filter((_, i) => i !== idx));
  }
  setEnvKey(idx: number, key: string): void {
    this.customEnv.update((rows) => rows.map((r, i) => (i === idx ? { ...r, key } : r)));
  }
  setEnvValue(idx: number, value: string): void {
    this.customEnv.update((rows) => rows.map((r, i) => (i === idx ? { ...r, value } : r)));
  }
  /** True when any custom row has a key that isn't a valid env identifier (blocks save). */
  invalidEnvKeys = computed(() =>
    this.customEnv().some((r) => r.key.trim() !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key.trim())),
  );

  /** Auto (platform-injected) catalog vars — e.g. PAYLOAD_SECRET — the owner chose to OVERRIDE
   *  with a manual value on the next reload. Click the "auto" chip to open a masked input;
   *  blur it empty to revert to auto (the instance keeps its existing value). */
  editingAuto = signal<ReadonlySet<string>>(new Set());
  isEditingAuto(key: string): boolean {
    return this.editingAuto().has(key);
  }
  startEditAuto(key: string): void {
    this.editingAuto.update((s) => new Set(s).add(key));
  }
  onAutoBlur(key: string): void {
    if (!(this.envValues[key] ?? '').trim()) {
      this.envValues[key] = '';
      this.editingAuto.update((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

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
        // Pre-fill the env editor with the REAL decrypted values (admin-only) so a persisted
        // secret loads MASKED (dots, unmaskable via the eye) — never as an empty field.
        if (inst?.env_keys) {
          const values = inst.env ?? {};
          for (const k of inst.env_keys) {
            if (!(k in this.envValues)) this.envValues[k] = values[k] ?? '';
          }
          // CF-native (no fixed catalog env) → seed editable custom-var rows from the server
          // keys WITH their real values (masked in the UI). Skip PAYLOAD_SECRET (a catalog auto
          // var, shown in the catalog list) + any catalog-defined key.
          if (this.catalogApp()?.image?.startsWith('cf-native:')) {
            const catalogKeys = new Set((this.catalogApp()?.env ?? []).map((e) => e.key));
            const rows = inst.env_keys
              .filter((k) => k !== 'PAYLOAD_SECRET' && !catalogKeys.has(k))
              .map((k) => ({ key: k, value: values[k] ?? '' }));
            if (rows.length && this.customEnv().length === 0) this.customEnv.set(rows);
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
    const shouldPoll = status === 'provisioning' || status === 'starting' || status === 'running';
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
  /** Zone suffix (everything after the first label) → the domain-manager's platform suffix. */
  hostSuffix(hostname: string): string {
    const parts = (hostname || '').split('.');
    return parts.length > 1 ? parts.slice(1).join('.') : 'cms.projectsites.dev';
  }

  formatLog(l: LogLine): string {
    const ts = l.ts ?? '';
    const lvl = (l.level ?? 'info').toUpperCase().padEnd(5, ' ');
    return `${ts}  ${lvl}  ${l.msg}\n`;
  }

  restart(): void {
    const i = this.instance(); if (!i || this.busy()) return;
    this.busy.set(true); this.busyLabel.set('Restarting…');
    this.api.post(`/apps/instances/${i.id}/restart`, {}).subscribe({
      next: () => { this.busy.set(false); this.busyLabel.set(''); this.toast.success('Restart triggered'); this.load(); },
      error: () => { this.busy.set(false); this.busyLabel.set(''); },
    });
  }

  /** Start a stopped instance — the Stop↔Start toggle. Uses the restart endpoint (which for
   *  CF-native re-probes the Worker → running; for containers boots it) and shows "Starting…". */
  start(): void {
    const i = this.instance(); if (!i || this.busy()) return;
    this.busy.set(true); this.busyLabel.set('Starting…');
    this.api.post(`/apps/instances/${i.id}/restart`, {}).subscribe({
      next: () => { this.busy.set(false); this.busyLabel.set(''); this.toast.success('Starting instance'); this.load(); },
      error: () => { this.busy.set(false); this.busyLabel.set(''); },
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
    this.busy.set(true); this.busyLabel.set('Stopping…');
    this.api.post(`/apps/instances/${i.id}/stop`, {}).subscribe({
      next: () => { this.busy.set(false); this.busyLabel.set(''); this.toast.success('Stopped'); this.load(); },
      error: () => { this.busy.set(false); this.busyLabel.set(''); },
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
      message: `Destroy "${this.catalogApp()?.name ?? i.app_id}"? ${this.catalogApp()?.image?.startsWith('cf-native:') ? 'Its Worker, D1 database, R2 bucket' : 'Its container, all data'}, and the subdomain are released — this cannot be undone.`,
      confirmLabel: 'Destroy',
      danger: true,
    });
    if (!ok) return;
    this.performDestroy(i.id);
  }

  private performDestroy(id: string): void {
    this.busy.set(true); this.busyLabel.set('Destroying…');
    this.api.delete(`/apps/instances/${id}`).subscribe({
      next: () => {
        this.busy.set(false); this.busyLabel.set('');
        this.toast.success('Instance destroyed');
        this.router.navigate(['/admin/apps/instances']);
      },
      error: () => { this.busy.set(false); this.busyLabel.set(''); },
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
    if (this.invalidEnvKeys()) {
      this.toast.error('Env var names must start with a letter/underscore and contain only letters, numbers, underscores.');
      return;
    }
    // Merge owner-added custom rows (non-empty keys) over the catalog values.
    const overrides: Record<string, string> = { ...this.envValues };
    for (const r of this.customEnv()) {
      const key = r.key.trim();
      if (key) overrides[key] = r.value;
    }
    this.busy.set(true); this.busyLabel.set('Saving…');
    this.api.patch(`/apps/instances/${i.id}/env`, { env_overrides: overrides }).subscribe({
      next: () => { this.busy.set(false); this.busyLabel.set(''); this.toast.success(this.catalogApp()?.image?.startsWith('cf-native:') ? 'Env saved — redeploying Worker' : 'Env saved — restarting container'); this.load(); },
      error: () => { this.busy.set(false); this.busyLabel.set(''); },
    });
  }
}
