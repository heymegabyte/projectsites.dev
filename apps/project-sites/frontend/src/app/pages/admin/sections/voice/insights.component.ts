/**
 * app-voice-insights — at-a-glance KPI overview for the AI voice/SMS agent.
 *
 * Surfaces org-scoped aggregates from `GET /api/voice/insights` over the
 * `voice_calls` table: total calls, inbound/outbound split, average call
 * duration, sentiment mix, and total spend. Every one of these was already
 * captured per call (status/duration/sentiment/cost) but never summarized —
 * the operator had to scroll the raw Conversations feed to gauge volume.
 *
 * Self-fetching, OnPush, zero inputs. The parent `voice.component` only renders
 * this inside its `@if (state.selectedSite())` guard, and the endpoint is
 * org-scoped via the auth session, so no site/org param is needed.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../../services/api.service';
import { RollingCounterComponent } from '../../../../components/rolling-counter/rolling-counter.component';
import { EmptyStateComponent } from '../../empty-state.component';

interface VoiceInsights {
  total_calls: number;
  by_direction: { inbound: number; outbound: number };
  avg_duration_seconds: number;
  sentiment_breakdown: {
    positive: number;
    neutral: number;
    negative: number;
    escalated_safety: number;
    flagged_scam: number;
  };
  total_cost_cents: number;
}

interface SentimentRow {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: 'good' | 'muted' | 'warn' | 'bad';
}

@Component({
  selector: 'app-voice-insights',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RollingCounterComponent, EmptyStateComponent],
  template: `
    <div data-testid="voice-insights">
      @if (loading()) {
        <div class="kpi-grid" aria-hidden="true">
          @for (n of [1, 2, 3, 4]; track n) {
            <div class="kpi-card kpi-skeleton"></div>
          }
        </div>
      } @else if (error()) {
        <p class="err" role="alert" data-testid="voice-insights-error">
          Couldn't load call insights just now. Reopen this tab to retry.
        </p>
      } @else if (data(); as d) {
        @if (d.total_calls === 0) {
          <app-empty-state
            icon="📊"
            title="No calls yet"
            body="Once your AI agent answers its first call or text, your volume, duration, sentiment and spend appear here automatically."
          />
        } @else {
          <!-- Headline KPI cards -->
          <div class="kpi-grid">
            <div class="kpi-card" role="group" aria-label="Total calls">
              <span class="kpi-num"><app-rolling-counter [value]="d.total_calls" [duration]="900" /></span>
              <span class="kpi-lbl">Total calls</span>
              <span class="kpi-sub">{{ d.by_direction.inbound }} in · {{ d.by_direction.outbound }} out</span>
            </div>
            <div class="kpi-card" role="group" aria-label="Average call duration">
              <span class="kpi-num">{{ avgDurationLabel() }}</span>
              <span class="kpi-lbl">Avg duration</span>
              <span class="kpi-sub">minutes:seconds per call</span>
            </div>
            <div class="kpi-card" role="group" aria-label="Total spend">
              <span class="kpi-num">{{ costLabel() }}</span>
              <span class="kpi-lbl">Total spend</span>
              <span class="kpi-sub">telephony + AI, all calls</span>
            </div>
            <div class="kpi-card" role="group" aria-label="Positive sentiment share">
              <span class="kpi-num">{{ positivePct() }}%</span>
              <span class="kpi-lbl">Positive</span>
              <span class="kpi-sub">of scored conversations</span>
            </div>
          </div>

          <!-- Sentiment breakdown bars -->
          <div class="sentiment" role="group" aria-label="Sentiment breakdown">
            <h3 class="sentiment-h">Sentiment mix</h3>
            @for (row of sentimentRows(); track row.key) {
              <div class="sentiment-row" [attr.data-tone]="row.tone">
                <span class="sentiment-lbl">{{ row.label }}</span>
                <span class="sentiment-track" aria-hidden="true">
                  <span class="sentiment-bar" [style.width.%]="barPct(row.count)"></span>
                </span>
                <span class="sentiment-count">{{ row.count }}</span>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
      }
      .kpi-card {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 16px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(0, 229, 255, 0.14);
      }
      .kpi-skeleton {
        min-height: 92px;
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.03));
        background-size: 200% 100%;
        animation: kpi-shimmer 1.3s ease-in-out infinite;
        border-color: rgba(255, 255, 255, 0.06);
      }
      @keyframes kpi-shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }
      .kpi-num {
        font: 800 1.6rem/1 'Sora', system-ui, sans-serif;
        color: var(--ps-accent, #00e5ff);
        letter-spacing: -0.02em;
      }
      .kpi-lbl {
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--ps-ink, #f4f4ff);
        margin-top: 4px;
      }
      .kpi-sub {
        font-size: 0.68rem;
        color: var(--text-secondary, #9aa);
      }
      .sentiment {
        margin-top: 18px;
        padding: 16px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .sentiment-h {
        font: 700 0.62rem/1 'JetBrains Mono', ui-monospace, monospace;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
        margin: 0 0 12px;
      }
      .sentiment-row {
        display: grid;
        grid-template-columns: 92px 1fr 40px;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .sentiment-lbl {
        font-size: 0.74rem;
        color: var(--ps-ink, #f4f4ff);
      }
      .sentiment-track {
        display: block;
        height: 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }
      .sentiment-bar {
        display: block;
        height: 100%;
        border-radius: 6px;
        background: var(--ps-accent, #00e5ff);
        transition: width 0.5s ease;
      }
      .sentiment-count {
        font-size: 0.74rem;
        font-weight: 700;
        text-align: right;
        color: var(--text-secondary, #9aa);
      }
      .sentiment-row[data-tone='warn'] .sentiment-bar {
        background: #f6c344;
      }
      .sentiment-row[data-tone='bad'] .sentiment-bar {
        background: #ff6b6b;
      }
      .err {
        font-size: 0.82rem;
        color: #ff9b9b;
        padding: 16px;
      }
    `,
  ],
})
export class VoiceInsightsComponent {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly error = signal(false);
  readonly data = signal<VoiceInsights | null>(null);

  constructor() {
    this.api
      .get<{ data: VoiceInsights }>('/voice/insights')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.data.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }

  readonly sentimentRows = computed<SentimentRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    const s = d.sentiment_breakdown;
    return [
      { key: 'positive', label: 'Positive', count: s.positive, tone: 'good' },
      { key: 'neutral', label: 'Neutral', count: s.neutral, tone: 'muted' },
      { key: 'negative', label: 'Negative', count: s.negative, tone: 'warn' },
      { key: 'escalated_safety', label: 'Escalated', count: s.escalated_safety, tone: 'bad' },
      { key: 'flagged_scam', label: 'Flagged scam', count: s.flagged_scam, tone: 'bad' },
    ];
  });

  private readonly maxSentiment = computed(() =>
    Math.max(1, ...this.sentimentRows().map((r) => r.count)),
  );

  readonly avgDurationLabel = computed(() => {
    const s = Math.max(0, Math.round(this.data()?.avg_duration_seconds ?? 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  });

  readonly costLabel = computed(() => `$${((this.data()?.total_cost_cents ?? 0) / 100).toFixed(2)}`);

  readonly positivePct = computed(() => {
    const d = this.data();
    if (!d || d.total_calls === 0) return 0;
    const scored =
      d.sentiment_breakdown.positive +
      d.sentiment_breakdown.neutral +
      d.sentiment_breakdown.negative +
      d.sentiment_breakdown.escalated_safety +
      d.sentiment_breakdown.flagged_scam;
    if (scored === 0) return 0;
    return Math.round((d.sentiment_breakdown.positive / scored) * 100);
  });

  barPct(count: number): number {
    return Math.round((count / this.maxSentiment()) * 100);
  }
}
