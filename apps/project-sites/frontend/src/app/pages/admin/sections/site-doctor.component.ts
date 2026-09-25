import { Component, signal, computed, inject, effect, DestroyRef } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { AdminStateService } from '../admin-state.service';

interface DoctorIssue {
  readonly id: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly title: string;
  readonly fix: string;
  readonly locked: boolean;
}
interface DoctorReport {
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly score: number;
  readonly summary: string;
  readonly issues: readonly DoctorIssue[];
  readonly locked_count: number;
}

/**
 * #59 Site Doctor — owner-facing A–F health report card. Reads
 * `/api/sites/:siteId/doctor?plan=` for the selected site and renders the grade,
 * score, summary, and prioritized one-tap fixes. Locked issues (free plan) show
 * a blurred upsell that deep-links to billing.
 */
@Component({
  selector: 'app-site-doctor',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="px-6 pb-6 max-md:px-4" data-testid="site-doctor">
      <h2 class="text-[1.05rem] font-bold text-white tracking-tight m-0">Site health</h2>
      <p class="text-[0.8rem] text-text-secondary mt-1 mb-3">
        An A–F report card with the highest-impact fixes for this site.
      </p>

      @if (loading()) {
        <div class="h-40 rounded-xl border border-white/[0.06] bg-white/[0.02] animate-pulse"
             aria-hidden="true"></div>
      } @else if (error()) {
        <div class="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-[0.82rem] text-red-200"
             role="status">
          Couldn’t load the site health report.
          <button type="button" class="underline ml-1" (click)="reload()">Retry</button>
        </div>
      } @else if (data()) {
        <div class="flex items-center gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 mb-3"
             data-testid="site-doctor-grade">
          <div class="text-5xl font-extrabold tabular-nums leading-none" [class]="gradeColor()">
            {{ data()!.grade }}
          </div>
          <div>
            <div class="text-[0.8rem] text-text-secondary">Health score</div>
            <div class="text-xl font-bold text-white tabular-nums">{{ data()!.score }}/100</div>
            <p class="text-[0.82rem] text-text-secondary mt-1 mb-0">{{ data()!.summary }}</p>
          </div>
        </div>

        @if (severityCounts().length) {
          <div class="flex flex-wrap gap-1.5 mb-2" data-testid="site-doctor-severity-summary"
               aria-label="Issues by severity">
            @for (s of severityCounts(); track s.severity) {
              <span class="text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                    [class]="sevClass(s.severity)">{{ s.count }} {{ s.severity }}</span>
            }
          </div>
        }

        <ul class="flex flex-col gap-2 list-none p-0 m-0" data-testid="site-doctor-issues">
          @for (i of data()!.issues; track i.id) {
            <li class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"
                [class.opacity-60]="i.locked">
              <div class="flex items-center gap-2">
                <span class="text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                      [class]="sevClass(i.severity)">{{ i.severity }}</span>
                <span class="text-[0.85rem] font-semibold text-white">{{ i.title }}</span>
              </div>
              @if (i.locked) {
                <a class="mt-1.5 inline-block text-[0.78rem] text-primary underline"
                   routerLink="/admin/billing" [queryParams]="{ upsell: 'site_doctor' }" data-testid="site-doctor-upsell">
                  🔒 Unlock this fix with Pro →
                </a>
              } @else {
                <p class="text-[0.78rem] text-text-secondary mt-1 mb-0">{{ i.fix }}</p>
              }
            </li>
          }
        </ul>
        @if (data()!.locked_count > 0) {
          <p class="text-[0.78rem] text-text-secondary mt-3" data-testid="site-doctor-lockednote">
            {{ data()!.locked_count }} more fix{{ data()!.locked_count === 1 ? '' : 'es' }} unlock with Pro.
          </p>
        }
      }
    </section>
  `,
})
export class SiteDoctorComponent {
  private readonly api = inject(ApiService);
  private readonly state = inject(AdminStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly data = signal<DoctorReport | null>(null);

  readonly siteId = computed<string | null>(() => this.state.selectedSite()?.id ?? null);
  /** Map the site's coarse free/paid to the backend PlanTier (paid → pro unlocks all). */
  private readonly plan = computed<'free' | 'pro'>(() =>
    this.state.selectedSite()?.plan === 'paid' ? 'pro' : 'free',
  );

  readonly gradeColor = computed(() => {
    const g = this.data()?.grade;
    if (g === 'A' || g === 'B') return 'text-green-400';
    if (g === 'C') return 'text-amber-400';
    return 'text-red-400';
  });

  /**
   * Issue counts by severity, worst-first, only for severities that actually occur — an
   * at-a-glance triage row ("2 critical · 3 medium") so the owner sees the shape of the
   * work before reading every card. Derived from the fetched issues; no new request, and
   * a clean site yields [] (the summary hides), never a fabricated "0 critical".
   */
  readonly severityCounts = computed<Array<{ severity: DoctorIssue['severity']; count: number }>>(() => {
    const issues = this.data()?.issues ?? [];
    const order: DoctorIssue['severity'][] = ['critical', 'high', 'medium', 'low'];
    return order
      .map((severity) => ({ severity, count: issues.filter((i) => i.severity === severity).length }))
      .filter((s) => s.count > 0);
  });

  constructor() {
    effect(() => {
      const id = this.siteId();
      if (!id) {
        this.data.set(null);
        return;
      }
      this.fetch(id, this.plan());
    });
  }

  reload(): void {
    const id = this.siteId();
    if (id) this.fetch(id, this.plan());
  }

  sevClass(sev: DoctorIssue['severity']): string {
    switch (sev) {
      case 'critical':
        return 'bg-red-500/15 text-red-300';
      case 'high':
        return 'bg-amber-500/15 text-amber-300';
      case 'medium':
        return 'bg-sky-500/15 text-sky-300';
      default:
        return 'bg-white/[0.06] text-text-secondary';
    }
  }

  private fetch(siteId: string, plan: 'free' | 'pro'): void {
    this.loading.set(true);
    this.error.set(false);
    this.api
      .get<DoctorReport>(`/sites/${siteId}/doctor?plan=${plan}`)
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
