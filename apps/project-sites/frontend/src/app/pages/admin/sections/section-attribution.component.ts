import { Component, signal, computed, inject, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { AdminStateService } from '../admin-state.service';

/** One section's conversion attribution row (mirrors the worker SectionConversionSchema). */
interface SectionRow {
  readonly section: string;
  readonly count: number;
  readonly percent: number;
  readonly calls: number;
  readonly directions: number;
  readonly emails: number;
}

interface SectionConversions {
  readonly siteId: string;
  readonly windowDays: number;
  readonly totalConversions: number;
  readonly sections: readonly SectionRow[];
  readonly generatedAt: string;
}

/**
 * AN27 — section-level conversion attribution ("Services drives 40% of calls").
 * Reads `/api/sites/:siteId/analytics/sections` (AN18 click-to-call/directions
 * conversions tagged with the AN26 `data-ps-section`) for the selected site and
 * renders a ranked breakdown with share bars + per-kind (call/directions/email)
 * counts. The owner "moat": which part of the page actually drives the phone.
 */
@Component({
  selector: 'app-section-attribution',
  standalone: true,
  template: `
    <section class="px-6 pb-6 max-md:px-4" data-testid="section-attribution">
      <h2 class="text-[1.05rem] font-bold text-white tracking-tight m-0">Conversions by section</h2>
      <p class="text-[0.8rem] text-text-secondary mt-1 mb-3">
        Which part of the page drives calls &amp; directions — the conversions that matter most.
      </p>

      @if (loading()) {
        <div class="h-24 rounded-xl border border-white/[0.06] bg-white/[0.02] animate-pulse"
             aria-hidden="true"></div>
      } @else if (error()) {
        <div class="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-[0.82rem] text-red-200"
             role="status">
          Couldn’t load section attribution.
          <button type="button" class="underline ml-1" (click)="reload()">Retry</button>
        </div>
      } @else if (!data() || data()!.totalConversions === 0) {
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 text-[0.82rem] text-text-secondary"
             data-testid="section-attribution-empty">
          No call or directions conversions yet. Once visitors tap a phone number or
          “Get directions”, you’ll see which section drove each one.
        </div>
      } @else {
        <ul class="flex flex-col gap-2 list-none p-0 m-0" data-testid="section-attribution-rows">
          @for (s of data()!.sections; track s.section; let i = $index) {
            <li class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"
                [class.border-primary]="i === 0 && s.count > 0">
              <div class="flex items-baseline justify-between gap-3">
                <span class="flex items-baseline gap-2 min-w-0">
                  <span class="text-[0.85rem] font-semibold text-white truncate" [attr.title]="s.section">
                    {{ s.section }}
                  </span>
                  @if (i === 0 && s.count > 0) {
                    <span class="shrink-0 rounded-full bg-primary/15 text-primary text-[0.6rem] font-bold uppercase tracking-wide px-1.5 py-0.5"
                          data-testid="section-attribution-top"
                          title="Drives the most calls &amp; directions of any section">
                      🏆 Top driver
                    </span>
                  }
                </span>
                <span class="text-[0.8rem] font-bold text-primary tabular-nums whitespace-nowrap">
                  {{ s.percent }}% · {{ s.count }}
                </span>
              </div>
              <div class="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
                <div class="h-full rounded-full bg-primary" [style.width.%]="s.percent"></div>
              </div>
              <div class="mt-1.5 flex gap-3 text-[0.72rem] text-text-secondary tabular-nums">
                @if (s.calls > 0) { <span>📞 {{ s.calls }} calls</span> }
                @if (s.directions > 0) { <span>🧭 {{ s.directions }} directions</span> }
                @if (s.emails > 0) { <span>✉️ {{ s.emails }} emails</span> }
              </div>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class SectionAttributionComponent {
  private readonly api = inject(ApiService);
  private readonly state = inject(AdminStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly data = signal<SectionConversions | null>(null);

  /** The selected site's id (attribution is per-site). */
  readonly siteId = computed<string | null>(() => this.state.selectedSite()?.id ?? null);

  constructor() {
    // Re-fetch whenever the selected site changes.
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
      .get<SectionConversions>(`/sites/${siteId}/analytics/sections`)
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
