import { Component, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminAnalyticsComponent } from './analytics.component';
import { AdminAnalyticsLiveComponent } from './analytics-live.component';
import { AdminActivationFunnelComponent } from './activation-funnel.component';
import { AdminSocialAnalyticsComponent } from './social-analytics.component';
import { SectionAttributionComponent } from './section-attribution.component';
import { FormAnalyticsComponent } from './form-analytics.component';
import { VisitorFunnelComponent } from './visitor-funnel.component';
import { SiteDoctorComponent } from './site-doctor.component';
import { ApiService } from '../../../services/api.service';
import { AdminStateService } from '../admin-state.service';
import { ToastService } from '../../../services/toast.service';
import { copyToClipboard } from '../../../utils/clipboard';
import { downloadText } from '../../../utils/csv-export';

type AnalyticsTab =
  | 'overview'
  | 'live'
  | 'funnel'
  | 'sections'
  | 'forms'
  | 'visitor'
  | 'health'
  | 'social';

/**
 * Unified analytics dashboard — combines aggregate traffic, the raw live event
 * stream, the activation funnel, and SOCIAL performance into ONE tabbed surface.
 * Social analytics lives here as a dedicated `social` tab (no standalone page),
 * so everything a site owner measures is in one place.
 *
 * Deep-linkable + bookmarkable via `?tab=overview|live|funnel|social`; the legacy
 * `/admin/analytics-live` + `/admin/social/analytics` routes redirect here.
 */
@Component({
  selector: 'app-admin-analytics-dashboard',
  standalone: true,
  imports: [
    AdminAnalyticsComponent,
    AdminAnalyticsLiveComponent,
    AdminActivationFunnelComponent,
    AdminSocialAnalyticsComponent,
    SectionAttributionComponent,
    FormAnalyticsComponent,
    VisitorFunnelComponent,
    SiteDoctorComponent,
  ],
  template: `
    <div class="px-6 pt-5 pb-2 max-md:px-4" data-testid="analytics-dashboard">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">Analytics</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-3">
        Traffic, the live event stream, the activation funnel, and social performance — all in one place.
      </p>
      <div class="flex items-center gap-2 flex-wrap mb-3">
        <div class="flex overflow-x-auto max-w-full min-w-0 gap-1 p-1 rounded-xl border border-white/[0.06] bg-white/[0.02]" role="tablist" aria-label="Analytics view">
        @for (t of tabs; track t.id) {
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="tab() === t.id"
            [attr.data-testid]="'analytics-tab-' + t.id"
            class="px-3.5 py-1.5 rounded-lg text-[0.8rem] font-semibold transition-all cursor-pointer shrink-0 whitespace-nowrap"
            [class.bg-primary]="tab() === t.id"
            [class.text-dark]="tab() === t.id"
            [class.text-text-secondary]="tab() !== t.id"
            [class.hover:text-white]="tab() !== t.id"
            (click)="select(t.id)">
            {{ t.label }}
          </button>
        }
        </div>
        <button
          type="button"
          data-testid="share-readonly-btn"
          class="px-3 py-1.5 rounded-lg text-[0.8rem] font-semibold border border-white/[0.1] bg-white/[0.02] text-text-secondary hover:text-white transition-all cursor-pointer disabled:opacity-50"
          [disabled]="sharing()"
          (click)="shareReadOnly()">
          {{ sharing() ? 'Generating…' : '🔗 Share read-only link' }}
        </button>
        <button
          type="button"
          data-testid="export-csv-btn"
          class="px-3 py-1.5 rounded-lg text-[0.8rem] font-semibold border border-white/[0.1] bg-white/[0.02] text-text-secondary hover:text-white transition-all cursor-pointer disabled:opacity-50"
          [disabled]="exporting()"
          (click)="exportCsv()">
          {{ exporting() ? 'Exporting…' : '⬇ Export CSV' }}
        </button>
      </div>
    </div>

    @if (tab() === 'overview') {
      <app-admin-analytics />
    } @else if (tab() === 'live') {
      <app-admin-analytics-live />
    } @else if (tab() === 'funnel') {
      <app-admin-activation-funnel />
    } @else if (tab() === 'sections') {
      <app-section-attribution />
    } @else if (tab() === 'forms') {
      <app-form-analytics />
    } @else if (tab() === 'visitor') {
      <app-visitor-funnel />
    } @else if (tab() === 'health') {
      <app-site-doctor />
    } @else {
      <app-social-analytics />
    }
  `,
})
export class AdminAnalyticsDashboardComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ApiService);
  private readonly state = inject(AdminStateService);
  private readonly toast = inject(ToastService);

  /** AN48 — busy guard while minting a read-only share link. */
  readonly sharing = signal(false);
  /** AN42 — busy guard while exporting the analytics CSV. */
  readonly exporting = signal(false);

  readonly tabs: ReadonlyArray<{ id: AnalyticsTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'live', label: 'Live Events' },
    { id: 'funnel', label: 'Activation Funnel' },
    { id: 'sections', label: 'By Section' },
    { id: 'forms', label: 'Forms' },
    { id: 'visitor', label: 'Visitor Funnel' },
    { id: 'health', label: 'Site Health' },
    { id: 'social', label: 'Social' },
  ];
  readonly tab = signal<AnalyticsTab>('overview');

  ngOnInit(): void {
    // Sync the active tab from `?tab=` so the view is deep-linkable + back/forward
    // restores it. takeUntilDestroyed: ActivatedRoute observables never complete.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const t = q.get('tab');
      this.tab.set(
        t === 'live' ||
        t === 'funnel' ||
        t === 'sections' ||
        t === 'forms' ||
        t === 'visitor' ||
        t === 'health' ||
        t === 'social'
          ? t
          : 'overview',
      );
    });
  }

  select(tab: AnalyticsTab): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      queryParamsHandling: 'merge',
    });
  }

  /**
   * AN48 — mint a public read-only share link for the selected site and copy it
   * to the clipboard. Busy-guarded against double-submit; surfaces the outcome.
   */
  shareReadOnly(): void {
    if (this.sharing()) return;
    const site = this.state.selectedSite();
    if (!site) {
      this.toast.error('Select a site first.');
      return;
    }
    this.sharing.set(true);
    this.api
      .post<{ url: string; expiresAt: number }>(`/sites/${site.id}/analytics/share`, {})
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: async (r) => {
          const copied = await copyToClipboard(r.url);
          this.toast.success(copied ? 'Read-only link copied to clipboard' : r.url);
          this.sharing.set(false);
        },
        error: () => {
          this.toast.error('Couldn’t create a share link.');
          this.sharing.set(false);
        },
      });
  }

  /**
   * AN42 — fetch the analytics summary as CSV and trigger a browser download.
   * Busy-guarded; the data is non-PII aggregate counts.
   */
  exportCsv(): void {
    if (this.exporting()) return;
    const site = this.state.selectedSite();
    if (!site) {
      this.toast.error('Select a site first.');
      return;
    }
    this.exporting.set(true);
    this.api
      .get<{ filename: string; csv: string }>(`/sites/${site.id}/analytics/export`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          downloadText(r.filename || 'analytics.csv', r.csv, 'text/csv;charset=utf-8');
          this.toast.success('Analytics CSV downloaded');
          this.exporting.set(false);
        },
        error: () => {
          this.toast.error('Couldn’t export analytics.');
          this.exporting.set(false);
        },
      });
  }

}
