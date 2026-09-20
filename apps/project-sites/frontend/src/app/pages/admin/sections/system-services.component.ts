import { Component, computed, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ApiService } from '../../../services/api.service';
import { ErrorCardComponent } from '../../../components/states/error-card.component';

/** One platform service, mirroring the worker's SERVICE_REGISTRY entry shape (§66). */
interface PlatformService {
  readonly id: string;
  readonly name: string;
  readonly domain?: string;
  readonly category: string;
  readonly runtime: string;
  readonly status: 'planned' | 'scaffolded' | 'integrated' | 'production' | 'deprecated' | 'removed';
  readonly access: string;
  readonly datastore?: readonly string[];
  readonly notes?: string;
}

interface ServicesResponse {
  readonly services: readonly PlatformService[];
  readonly counts: Record<string, number>;
}

/** Live health of one integration from `GET /api/integrations/health`. */
type LiveHealth = 'healthy' | 'degraded' | 'failing' | 'unknown' | 'removed';
interface IntegrationHealthResponse {
  readonly integrations: ReadonlyArray<{ integration: string; status: LiveHealth }>;
}

/**
 * Maps a SERVICE_REGISTRY id (namespaced, e.g. `billing-stripe`) to its bare
 * integration-health probe name (`stripe`). Only services with a live probe in
 * `GET /api/integrations/health` appear here; the rest show their declared
 * lifecycle status only. Keep in lockstep with integration_health.ts
 * KNOWN_INTEGRATIONS + service-registry.ts ids.
 */
const LIVE_PROBE_NAME: Readonly<Record<string, string>> = {
  'email-listmonk': 'listmonk',
  'crm-twenty': 'twenty',
  'billing-stripe': 'stripe',
  'traces-langfuse': 'langfuse',
};

/** Display order: live first, planned last. */
const STATUS_ORDER: Record<string, number> = {
  production: 0,
  integrated: 1,
  scaffolded: 2,
  planned: 3,
  deprecated: 4,
  removed: 5,
};

/**
 * System Services — operator-only catalog of every platform service the worker's
 * SERVICE_REGISTRY (§66) declares: the edge API, data stores, auth (Better Auth),
 * billing, the AI gateway, and every self-hosted subdomain container (mail, CRM,
 * webhooks, …). Read-only
 * — the registry is the source of truth. Surfaces what previously had NO admin view.
 *
 * Backed by `GET /api/super-admin/services` (super-admin gated; 403 to non-operators).
 */
@Component({
  selector: 'app-system-services',
  standalone: true,
  imports: [ErrorCardComponent],
  template: `
    <div class="px-6 pt-5 pb-8 max-md:px-4" data-testid="system-services">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">System Services</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-4">
        Every platform service ProjectSites runs or depends on — edge, data, auth, billing, AI,
        and the self-hosted subdomain containers. Read-only operator catalog.
      </p>

      @if (loading()) {
        <div class="grid gap-2" aria-busy="true">
          @for (i of [1,2,3,4,5,6]; track i) {
            <div class="h-[58px] rounded-xl border border-white/[0.06] bg-white/[0.02] animate-pulse"></div>
          }
        </div>
      } @else if (loadError()) {
        <app-error-card title="Service catalog unavailable" [message]="loadError()!" (retry)="load()" />
      } @else {
        <!-- lifecycle-status counts strip -->
        <div class="flex flex-wrap gap-2 mb-2" data-testid="system-services-counts">
          @for (c of countChips(); track c.key) {
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.78rem] font-semibold border"
              [class]="chipClass(c.key)">
              <span class="tabular-nums">{{ c.value }}</span>
              <span class="opacity-80">{{ c.key }}</span>
            </span>
          }
        </div>

        <!-- live-health summary across the probed integrations (at-a-glance platform health) -->
        @if (healthSummary().length) {
          <div class="flex flex-wrap items-center gap-2 mb-4" data-testid="system-services-health-summary">
            <span class="text-[0.6rem] font-bold uppercase tracking-wider text-text-secondary/70">Live health</span>
            @for (h of healthSummary(); track h.key) {
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[0.72rem] font-semibold border"
                [class]="healthLabelClass(h.key)" [attr.data-health]="h.key"
                [attr.data-testid]="'health-summary-' + h.key">
                <span class="w-1.5 h-1.5 rounded-full" [class]="healthDotClass(h.key)" aria-hidden="true"></span>
                <span class="tabular-nums">{{ h.value }}</span>
                <span class="opacity-80">{{ h.key }}</span>
              </span>
            }
          </div>
        }

        <div class="grid gap-2" role="list">
          @for (s of services(); track s.id) {
            <div role="listitem"
              class="flex items-start gap-3 p-3.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:border-primary/30 transition-colors"
              [attr.data-testid]="'service-' + s.id">
              <span class="mt-0.5 shrink-0 w-2 h-2 rounded-full" [class]="dotClass(s.status)" aria-hidden="true"></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[0.92rem] font-bold text-white">{{ s.name }}</span>
                  <span class="px-2 py-0.5 rounded-md text-[0.68rem] font-bold uppercase tracking-wide border"
                    [class]="badgeClass(s.status)">{{ s.status }}</span>
                  @if (liveStatusFor(s.id); as h) {
                    <span
                      class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[0.62rem] font-semibold uppercase tracking-wide border"
                      [class]="healthLabelClass(h)"
                      [attr.data-testid]="'service-health-' + s.id"
                      [attr.data-health]="h"
                      [attr.title]="'Live health probe: ' + h">
                      <span class="w-1.5 h-1.5 rounded-full" [class]="healthDotClass(h)" aria-hidden="true"></span>
                      {{ h }}
                    </span>
                  }
                </div>
                <div class="flex items-center gap-2.5 flex-wrap mt-1 text-[0.74rem] text-text-secondary">
                  @if (s.domain) {
                    <a [href]="'https://' + cleanDomain(s.domain)" target="_blank" rel="noopener"
                      class="text-primary hover:underline font-medium">{{ s.domain }}</a>
                  }
                  <span class="font-mono">{{ s.runtime }}</span>
                  <span class="opacity-50">·</span>
                  <span>{{ s.category }}</span>
                  @if (s.datastore?.length) {
                    <span class="opacity-50">·</span>
                    <span class="font-mono opacity-80">{{ s.datastore!.join(', ') }}</span>
                  }
                </div>
                @if (s.notes) {
                  <p class="text-[0.72rem] text-text-secondary mt-1.5 line-clamp-2" [attr.title]="s.notes">{{ s.notes }}</p>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class SystemServicesComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  private readonly raw = signal<readonly PlatformService[]>([]);
  private readonly counts = signal<Record<string, number>>({});
  /** Live probe status keyed by bare integration name (empty until aggregate resolves). */
  private readonly liveHealth = signal<ReadonlyMap<string, LiveHealth>>(new Map());

  /**
   * Sorted live-first for the operator scan. `removed` services are dropped
   * entirely — a decommissioned service (Inngest, Nango, …) is a tombstone in
   * the registry for audit/referential-integrity, NOT something the operator
   * should see in the live catalog. The tab shows only what actually runs.
   */
  readonly services = computed(() =>
    [...this.raw()]
      .filter((s) => s.status !== 'removed')
      .sort(
        (a, b) =>
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
          a.name.localeCompare(b.name),
      ),
  );

  readonly countChips = computed(() =>
    (['production', 'integrated', 'scaffolded', 'planned'] as const)
      .map((key) => ({ key, value: this.counts()[key] ?? 0 }))
      .filter((c) => c.value > 0),
  );

  /**
   * Live-health summary across the probed integrations — platform health at a
   * glance, WORST-first (failing → degraded → unknown → healthy). Excludes
   * decommissioned services (they're a lifecycle state, not a health signal).
   */
  readonly healthSummary = computed(() => {
    const tally: Partial<Record<LiveHealth, number>> = {};
    for (const h of this.liveHealth().values()) {
      if (h === 'removed') continue;
      tally[h] = (tally[h] ?? 0) + 1;
    }
    return (['failing', 'degraded', 'unknown', 'healthy'] as const)
      .map((key) => ({ key, value: tally[key] ?? 0 }))
      .filter((c) => c.value > 0);
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    forkJoin({
      catalog: this.api.get<ServicesResponse>('/super-admin/services'),
      // Live probe is best-effort — a probe failure must NEVER blank the catalog.
      health: this.api
        .get<IntegrationHealthResponse>('/integrations/health')
        .pipe(catchError(() => of<IntegrationHealthResponse>({ integrations: [] }))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ catalog, health }) => {
          this.raw.set(Array.isArray(catalog?.services) ? catalog.services : []);
          this.counts.set(catalog?.counts ?? {});
          const map = new Map<string, LiveHealth>();
          for (const i of health?.integrations ?? []) map.set(i.integration, i.status);
          this.liveHealth.set(map);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set('Could not load the service catalog.');
          this.loading.set(false);
        },
      });
  }

  /** Live probe status for a service row, or null if the service has no probe. */
  liveStatusFor(id: string): LiveHealth | null {
    const probe = LIVE_PROBE_NAME[id];
    return probe ? (this.liveHealth().get(probe) ?? null) : null;
  }

  healthDotClass(h: LiveHealth): string {
    if (h === 'healthy') return 'bg-emerald-400';
    if (h === 'degraded') return 'bg-amber-400';
    if (h === 'failing') return 'bg-red-400';
    return 'bg-white/25'; // unknown / removed
  }

  healthLabelClass(h: LiveHealth): string {
    if (h === 'healthy') return 'border-emerald-400/30 text-emerald-300 bg-emerald-400/10';
    if (h === 'degraded') return 'border-amber-400/30 text-amber-300 bg-amber-400/10';
    if (h === 'failing') return 'border-red-400/30 text-red-300 bg-red-400/10';
    return 'border-white/15 text-text-secondary bg-white/[0.03]'; // unknown / removed
  }

  /** Strip a wildcard prefix (`*.projectsites.dev`) for the href. */
  cleanDomain(domain: string): string {
    return domain.replace(/^\*\./, '');
  }

  dotClass(status: string): string {
    if (status === 'production') return 'bg-emerald-400';
    if (status === 'integrated') return 'bg-primary';
    if (status === 'scaffolded') return 'bg-amber-400';
    if (status === 'planned') return 'bg-white/30';
    return 'bg-white/20';
  }

  badgeClass(status: string): string {
    if (status === 'production') return 'border-emerald-400/30 text-emerald-300 bg-emerald-400/10';
    if (status === 'integrated') return 'border-primary/30 text-primary bg-primary/10';
    if (status === 'scaffolded') return 'border-amber-400/30 text-amber-300 bg-amber-400/10';
    return 'border-white/15 text-text-secondary bg-white/[0.03]';
  }

  chipClass(key: string): string {
    if (key === 'production') return 'border-emerald-400/30 text-emerald-300 bg-emerald-400/[0.06]';
    if (key === 'integrated') return 'border-primary/30 text-primary bg-primary/[0.06]';
    if (key === 'scaffolded') return 'border-amber-400/30 text-amber-300 bg-amber-400/[0.06]';
    return 'border-white/12 text-text-secondary bg-white/[0.02]';
  }
}
