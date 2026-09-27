/**
 * Pulse Social — full-page analytics drill-down at `/admin/social/analytics`.
 *
 * Deeper version of the SocialPerformanceWidget. Same data source
 * (`/api/social/analytics/aggregate?days=N`) but renders per-account /
 * per-channel breakdowns, time-window switcher, and a clearer best-time
 * heatmap. Pure standalone Angular 19 + signals.
 */
import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../../services/api.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { ErrorCardComponent } from '../../../components/states';
import { BestTimeToPostComponent } from './best-time-to-post.component';
import { BestPostsComponent } from './best-posts.component';
import {
  WidgetRendererComponent,
} from './dashboard/widgets';

interface PlatformTotals {
  platform: string;
  posts: number;
  impressions: number;
  reach: number;
  engagement: number;
}

interface BestPost {
  post_id: string;
  publish_id: string;
  platform: string;
  external_url: string | null;
  content_preview: string;
  impressions: number;
  engagement: number;
}

interface BestTimeSlot {
  day: number;
  hour: number;
  confidence: number;
}

interface AggregateResponse {
  window_days: number;
  generated_at: string;
  platform_totals: PlatformTotals[];
  best_posts: BestPost[];
  best_times: { platform: string; slots: BestTimeSlot[] };
}

@Component({
  selector: 'app-social-analytics',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, RevealDirective, WidgetRendererComponent, ErrorCardComponent, BestTimeToPostComponent, BestPostsComponent],
  template: `
    <section class="page" appReveal data-testid="social-analytics-section">
      <header class="page-hd">
        <div>
          <h1>Social analytics</h1>
          <p class="sub">Performance across every connected account, last {{ days() }} days.</p>
        </div>
        <nav class="windows" aria-label="Time window">
          @for (w of windows; track w) {
            <button
              type="button"
              [class.active]="days() === w"
              (click)="setDays(w)"
            >{{ w }}d</button>
          }
        </nav>
      </header>

      @if (error()) {
        <app-error-card
          title="Couldn't load social analytics"
          [message]="error()"
          [correlationId]="loadErrorRef()"
          hint="The analytics service didn't respond. Retry, or check your connected accounts."
          (retry)="reload()" />
      } @else if (data()) {
        <div class="widget">
          <app-widget-renderer name="social-performance" [props]="widgetProps()" />
        </div>

        <section class="card">
          <h2>All platforms</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Platform</th>
                <th scope="col">Posts</th>
                <th scope="col">Impressions</th>
                <th scope="col">Reach</th>
                <th scope="col">Engagement</th>
                <th scope="col" title="Engagement ÷ impressions — how much each impression interacts">Eng. rate</th>
              </tr>
            </thead>
            <tbody>
              @for (p of data()!.platform_totals; track p.platform) {
                <tr>
                  <th scope="row" class="platform" [attr.title]="p.platform">{{ p.platform }}</th>
                  <td>{{ p.posts | number }}</td>
                  <td>{{ p.impressions | number }}</td>
                  <td>{{ p.reach | number }}</td>
                  <td>{{ p.engagement | number }}</td>
                  <td [attr.title]="p.impressions > 0 ? null : 'No impressions yet — rate needs impressions to divide by'"
                      data-testid="social-eng-rate">{{ engRateLabel(p) }}</td>
                </tr>
              }
              @if (data()!.platform_totals.length === 0) {
                <tr><td colspan="6" class="empty">No published posts in window. <a routerLink="/admin/social">Compose one →</a></td></tr>
              }
            </tbody>
          </table>
        </section>

        <!-- best_times + best_posts were on the wire with no UI — surface them. -->
        <app-best-time-to-post [bestTimes]="data()!.best_times" />
        <app-best-posts [posts]="data()!.best_posts" />
      }
    </section>
  `,
  styles: [
    `
      :host { display: block; padding: 24px; color: var(--ps-ink, #f4f4ff); }
      .page-hd { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }
      h1 { font-family: 'Sora', system-ui, sans-serif; font-size: 1.6rem; margin: 0; }
      .sub { opacity: 0.7; margin: 4px 0 0; font-size: 0.92rem; }
      .windows { display: flex; gap: 4px; }
      .windows button {
        padding: 6px 12px;
        background: rgba(0, 229, 255, 0.06);
        border: 1px solid rgba(0, 229, 255, 0.12);
        color: var(--ps-ink, #f4f4ff);
        border-radius: 8px;
        cursor: pointer;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.8rem;
      }
      .windows button.active {
        background: rgba(0, 229, 255, 0.2);
        border-color: rgba(0, 229, 255, 0.5);
      }
      .widget { margin-bottom: 24px; }
      .card {
        padding: 18px 20px;
        border-radius: 14px;
        background: rgba(8, 8, 32, 0.55);
        border: 1px solid rgba(0, 229, 255, 0.12);
      }
      h2 { font-family: 'Sora', system-ui, sans-serif; font-size: 1.1rem; margin: 0 0 12px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); font-size: 0.9rem; font-weight: 400; }
      thead th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.55; }
      th.platform { text-transform: capitalize; font-weight: 600; }
      .empty { text-align: center; opacity: 0.55; padding: 18px; }
    `,
  ],
})
export class AdminSocialAnalyticsComponent implements OnInit {
  private api = inject(ApiService);
  readonly windows = [7, 30, 90] as const;

  days = signal<number>(30);
  loading = signal(true);
  error = signal('');
  /** Worker request_id from a failed analytics load → copyable support reference on the error card. */
  loadErrorRef = signal('');
  data = signal<AggregateResponse | null>(null);

  widgetProps = computed(() => {
    const d = this.data();
    return d ? (d as unknown as Record<string, unknown>) : {};
  });

  ngOnInit(): void {
    this.load();
  }

  setDays(d: number): void {
    if (this.days() === d) return;
    this.days.set(d);
    this.load();
  }

  /** Public retry entry point for the error-card recovery action. */
  reload(): void {
    this.load();
  }

  /**
   * Engagement rate = engagement ÷ impressions, as a display string. Returns an em-dash
   * when there are no impressions to divide by (honest — a rate off 0 impressions is
   * undefined, never shown as "0%"). Derived from data already on the row; no new request.
   */
  engRateLabel(p: PlatformTotals): string {
    if (!p || p.impressions <= 0) return '—';
    return `${Math.round((100 * p.engagement) / p.impressions)}%`;
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.loadErrorRef.set('');
    this.api
      .get<AggregateResponse>(`/social/analytics/aggregate?days=${this.days()}`)
      .subscribe({
        next: (res) => {
          this.data.set(res);
          this.loading.set(false);
        },
        error: (err: { error?: unknown }) => {
          this.error.set('Could not load analytics — try again.');
          this.loadErrorRef.set(this.requestIdFrom(err));
          this.loading.set(false);
        },
      });
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: { error?: unknown } | undefined): string {
    return (e?.error as { error?: { request_id?: string } } | undefined)?.error?.request_id ?? '';
  }
}
