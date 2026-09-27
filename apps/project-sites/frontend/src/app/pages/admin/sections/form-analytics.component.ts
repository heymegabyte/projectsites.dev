import { Component, signal, computed, inject, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { AdminStateService } from '../admin-state.service';

/** One form's completion row (mirrors the worker FormAnalyticsRowSchema). */
interface FormRow {
  readonly form: string;
  readonly starts: number;
  readonly submits: number;
  readonly completionRate: number;
  readonly abandoned: number;
}

interface FormAnalytics {
  readonly siteId: string;
  readonly windowDays: number;
  readonly forms: readonly FormRow[];
  readonly generatedAt: string;
}

/**
 * AN17 — per-form completion rate + abandonment. Reads
 * `/api/sites/:siteId/analytics/forms` (tracker `form_start`/`form_submit`
 * events keyed by form id/name/section) for the selected site and shows, per
 * form, how many starts converted to submits — the pageview→lead bridge.
 */
@Component({
  selector: 'app-form-analytics',
  standalone: true,
  template: `
    <section class="px-6 pb-6 max-md:px-4" data-testid="form-analytics">
      <h2 class="text-[1.05rem] font-bold text-white tracking-tight m-0">Form completion</h2>
      <p class="text-[0.8rem] text-text-secondary mt-1 mb-3">
        How many visitors who start a form actually finish it — and where they drop off.
      </p>

      @if (loading()) {
        <div class="h-24 rounded-xl border border-white/[0.06] bg-white/[0.02] animate-pulse"
             aria-hidden="true"></div>
      } @else if (error()) {
        <div class="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-[0.82rem] text-red-200"
             role="status">
          Couldn’t load form analytics.
          <button type="button" class="underline ml-1" (click)="reload()">Retry</button>
        </div>
      } @else if (!data() || data()!.forms.length === 0) {
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 text-[0.82rem] text-text-secondary"
             data-testid="form-analytics-empty">
          No form activity yet. Once visitors start filling out a form, you’ll see its
          completion rate and how many people abandoned it.
        </div>
      } @else {
        <ul class="flex flex-col gap-2 list-none p-0 m-0" data-testid="form-analytics-rows">
          @for (form of data()!.forms; track form.form) {
            <li class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              <div class="flex items-baseline justify-between gap-3">
                <span class="flex items-baseline gap-2 min-w-0">
                  <span class="text-[0.85rem] font-semibold text-white truncate" [attr.title]="form.form">
                    {{ form.form }}
                  </span>
                  @if (form.starts >= 5 && form.completionRate < 50) {
                    <span class="shrink-0 rounded-full bg-amber-500/15 text-amber-300 text-[0.6rem] font-bold uppercase tracking-wide px-1.5 py-0.5"
                          data-testid="form-analytics-attention"
                          title="Fewer than half of the people who start this form finish it — worth simplifying">
                      Needs attention
                    </span>
                  }
                </span>
                <span class="text-[0.8rem] font-bold text-primary tabular-nums whitespace-nowrap">
                  {{ form.completionRate }}% completed
                </span>
              </div>
              <div class="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
                <div class="h-full rounded-full bg-primary" [style.width.%]="form.completionRate"></div>
              </div>
              <div class="mt-1.5 flex gap-3 text-[0.72rem] text-text-secondary tabular-nums">
                <span>{{ form.submits }} / {{ form.starts }} finished</span>
                @if (form.abandoned > 0) { <span>⚠ {{ form.abandoned }} abandoned</span> }
              </div>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class FormAnalyticsComponent {
  private readonly api = inject(ApiService);
  private readonly state = inject(AdminStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly data = signal<FormAnalytics | null>(null);

  readonly siteId = computed<string | null>(() => this.state.selectedSite()?.id ?? null);

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
      .get<FormAnalytics>(`/sites/${siteId}/analytics/forms`)
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
