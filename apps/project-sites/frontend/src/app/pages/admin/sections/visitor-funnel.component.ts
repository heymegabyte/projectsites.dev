import { Component, signal, computed, inject, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { AdminStateService } from '../admin-state.service';

interface FunnelStage {
  readonly key: string;
  readonly label: string;
  readonly sessions: number;
  readonly percentOfLanding: number;
}
interface VisitorFunnel {
  readonly siteId: string;
  readonly windowDays: number;
  readonly stages: readonly FunnelStage[];
  readonly generatedAt: string;
}

/**
 * AN19 — per-site visitor funnel: landed → engaged (2+ pages) → converted, by
 * distinct session. Reads `/api/sites/:siteId/analytics/funnel` for the selected
 * site and renders proportional bars with the drop-off at each step.
 */
@Component({
  selector: 'app-visitor-funnel',
  standalone: true,
  template: `
    <section class="px-6 pb-6 max-md:px-4" data-testid="visitor-funnel">
      <h2 class="text-[1.05rem] font-bold text-white tracking-tight m-0">Visitor funnel</h2>
      <p class="text-[0.8rem] text-text-secondary mt-1 mb-3">
        How many visitors land, explore, and convert — and where they drop off (last 30 days).
      </p>

      @if (loading()) {
        <div class="h-28 rounded-xl border border-white/[0.06] bg-white/[0.02] animate-pulse"
             aria-hidden="true"></div>
      } @else if (error()) {
        <div class="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-[0.82rem] text-red-200"
             role="status">
          Couldn’t load the funnel.
          <button type="button" class="underline ml-1" (click)="reload()">Retry</button>
        </div>
      } @else if (!data() || (data()!.stages[0]?.sessions ?? 0) === 0) {
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 text-[0.82rem] text-text-secondary"
             data-testid="visitor-funnel-empty">
          No visitor sessions yet. Once people visit the site, you’ll see how many move
          from landing to engaging to converting.
        </div>
      } @else {
        <ul class="flex flex-col gap-2 list-none p-0 m-0" data-testid="visitor-funnel-stages">
          @for (s of rows(); track s.key) {
            <li class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-[0.85rem] font-semibold text-white">{{ s.label }}</span>
                <span class="flex items-baseline gap-2 whitespace-nowrap">
                  @if (s.dropFromPrev !== null && s.dropFromPrev > 0) {
                    <span class="text-[0.68rem] font-semibold text-amber-300/90 tabular-nums"
                          data-testid="visitor-funnel-drop"
                          [attr.title]="s.dropFromPrev + '% of the previous step did not reach ' + s.label">
                      ▼ {{ s.dropFromPrev }}% drop
                    </span>
                  }
                  <span class="text-[0.8rem] font-bold text-primary tabular-nums">
                    {{ s.sessions }} · {{ s.percentOfLanding }}%
                  </span>
                </span>
              </div>
              <div class="mt-2 h-2 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
                <div class="h-full rounded-full bg-primary" [style.width.%]="s.percentOfLanding"></div>
              </div>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class VisitorFunnelComponent {
  private readonly api = inject(ApiService);
  private readonly state = inject(AdminStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly data = signal<VisitorFunnel | null>(null);

  readonly siteId = computed<string | null>(() => this.state.selectedSite()?.id ?? null);

  /**
   * Stages decorated with the step-to-step drop-off — the % of the PREVIOUS stage's
   * sessions that did NOT reach this one (honest: null for the first stage and whenever
   * the previous stage had 0 sessions; a stage that grows/holds shows no drop). Fulfills
   * the card's stated promise ("where they drop off"), derived from the real session
   * counts already fetched — no new request, no fabricated number.
   */
  readonly rows = computed<Array<FunnelStage & { dropFromPrev: number | null }>>(() => {
    const stages = this.data()?.stages ?? [];
    return stages.map((s, i) => {
      const prev = stages[i - 1];
      const dropFromPrev =
        i === 0 || !prev || prev.sessions <= 0
          ? null
          : Math.max(0, Math.round((100 * (prev.sessions - s.sessions)) / prev.sessions));
      return { ...s, dropFromPrev };
    });
  });

  constructor() {
    effect(() => {
      const id = this.siteId();
      if (!id) {
        this.data.set(null);
        return;
      }
      this.fetch(id);
    });
  }

  reload(): void {
    const id = this.siteId();
    if (id) this.fetch(id);
  }

  private fetch(siteId: string): void {
    this.loading.set(true);
    this.error.set(false);
    this.api
      .get<VisitorFunnel>(`/sites/${siteId}/analytics/funnel`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.data.set(d);
          this.loading.set(false);
        },
        error: () => {
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }
}
