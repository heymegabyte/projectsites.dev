/**
 * Session-duration card — the session-LENGTH block of `/admin/analytics`. Complements the per-page
 * "time on page" (engagement) card: this measures how long a whole visit lasts, = the SUM of every
 * page's dwell across one tab-session. GA ships both metrics; this is "average session duration".
 *
 * Fetches `GET /api/sites/:siteId/analytics/session-duration` independently of the main summary load,
 * so it degrades on its own and never complicates the parent fetch.
 *
 * HONESTY: a "session" = one browser tab's visit (grouped by the cookieless per-tab `sid`); duration
 * is the total first-party dwell across its pages. Median (nearest-rank, the CrUX/CF method the rest
 * of the stack uses) — dwell is outlier-skewed. No sessions yet → honest "measuring…", never a fake 0.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';

/** Shape of `GET /api/sites/:siteId/analytics/session-duration`. */
export interface SessionDurationResponse {
  sessions: number;
  medianMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  distribution: { s30: number; s60: number; s180: number; s300: number };
}

@Component({
  selector: 'app-session-duration-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card sd" data-testid="session-duration-card" aria-label="Session duration">
      <div class="sd-kicker">Engagement</div>
      <h3 class="sd-head">
        <span class="sd-title">Session duration</span>
        <span
          class="sd-sub"
          data-testid="sd-source"
          title="How long a whole visit lasts — the total time across all its pages (tab-scoped, cookieless)."
          >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · tab-scoped,
          cookieless</span
        >
      </h3>

      @if (loading()) {
        <div class="sd-state" data-testid="sd-loading" aria-live="polite">
          Loading session-duration data…
        </div>
      } @else if (errored()) {
        <div class="sd-state" data-testid="sd-error" aria-live="assertive">
          Session-duration data is temporarily unavailable. It will reappear on the next refresh.
        </div>
      } @else if (isEmpty()) {
        <p class="sd-empty" data-testid="sd-empty" aria-live="polite">Measuring session length…</p>
      } @else {
        <div class="sd-stats" data-testid="sd-stats">
          <div class="sd-primary">
            <span class="sd-value" data-testid="sd-median">{{ formatMs(median()) }}</span>
            <span class="sd-plabel">median session</span>
          </div>
          <dl class="sd-secondary">
            <div>
              <dt>Average</dt>
              <dd data-testid="sd-avg">{{ formatMs(avg()) }}</dd>
            </div>
            <div>
              <dt>Longest</dt>
              <dd data-testid="sd-max">{{ formatMs(max()) }}</dd>
            </div>
            <div>
              <dt>Sessions</dt>
              <dd data-testid="sd-sessions">{{ sessions().toLocaleString() }}</dd>
            </div>
          </dl>
        </div>

        <ul class="sd-dist" data-testid="sd-dist">
          @for (b of buckets(); track b.label) {
            <li class="sd-brow" data-testid="sd-bucket">
              <div class="sd-brow-head">
                <span class="sd-blabel">{{ b.label }}</span>
                <span class="sd-bcount">{{ b.count.toLocaleString() }}</span>
              </div>
              <div class="sd-bar" aria-hidden="true">
                <div class="sd-bar-fill" [style.width.%]="barPct(b.count)"></div>
              </div>
            </li>
          }
        </ul>

        <p class="sd-disclaimer" data-testid="sd-disclaimer">
          A session is one browser tab's visit; duration is the total time across its pages
          (first-party, tab-scoped, cookieless). Distinct from time-on-page.
        </p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .card {
        border: 1px solid var(--ps-edge, rgba(255, 255, 255, 0.08));
        border-radius: var(--ps-radius-xl, 16px);
        background: rgba(255, 255, 255, 0.02);
        padding: 0.9rem 1rem;
      }
      .sd-kicker {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .sd-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 0.25rem 0 0.9rem;
      }
      .sd-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-size: 1rem;
        color: #fff;
      }
      .sd-sub {
        font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        cursor: help;
      }
      .sd-state,
      .sd-empty {
        margin: 0;
        font-size: 0.72rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .sd-stats {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.6rem 1.4rem;
        margin-bottom: 0.9rem;
      }
      .sd-primary {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
      }
      .sd-value {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 700;
        letter-spacing: -0.03em;
        font-size: 1.8rem;
        line-height: 1;
        color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .sd-plabel {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--ps-accent, #00e5ff);
        opacity: 0.85;
      }
      .sd-secondary {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem 1.2rem;
        margin: 0;
      }
      .sd-secondary div {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
      }
      .sd-secondary dt {
        font-size: 0.58rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
      }
      .sd-secondary dd {
        margin: 0;
        font-size: 0.84rem;
        font-weight: 600;
        color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .sd-dist {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.55rem;
      }
      .sd-brow-head {
        display: flex;
        justify-content: space-between;
        gap: 0.6rem;
        margin-bottom: 0.2rem;
      }
      .sd-blabel {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 0.68rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 80%, transparent);
      }
      .sd-bcount {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
      }
      .sd-bar {
        height: 5px;
        border-radius: 999px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        overflow: hidden;
      }
      .sd-bar-fill {
        height: 100%;
        border-radius: 999px;
        min-width: 0;
        background: linear-gradient(
          90deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent),
          var(--ps-accent, #00e5ff)
        );
      }
      .sd-disclaimer {
        margin: 0.7rem 0 0;
        font-size: 0.62rem;
        line-height: 1.4;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent);
        font-style: italic;
      }
    `,
  ],
})
export class SessionDurationCardComponent {
  /** The selected site's ID — fetched when present, idle when null. */
  readonly siteId = input<string | null>(null);
  /** Window length (days) for the freshness label and the API request. */
  readonly windowDays = input<number>(30);

  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly resp = signal<SessionDurationResponse | null>(null);
  readonly loading = signal(false);
  readonly errored = signal(false);
  /** Monotonic token — drops stale in-flight responses when the site switches. */
  private reqToken = 0;

  constructor() {
    effect(() => {
      const id = this.siteId();
      const days = this.windowDays();
      this.resp.set(null);
      this.errored.set(false);
      if (!id) {
        this.loading.set(false);
        return;
      }
      const token = ++this.reqToken;
      this.loading.set(true);
      this.api
        .get<SessionDurationResponse>(`/sites/${id}/analytics/session-duration`, {
          days: String(days),
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (r) => {
            if (token !== this.reqToken) return;
            this.resp.set(r);
            this.loading.set(false);
          },
          error: () => {
            if (token !== this.reqToken) return;
            this.errored.set(true);
            this.loading.set(false);
          },
        });
    });
  }

  readonly sessions = computed(() => this.resp()?.sessions ?? 0);
  readonly median = computed(() => this.resp()?.medianMs ?? null);
  readonly avg = computed(() => this.resp()?.avgMs ?? null);
  readonly max = computed(() => this.resp()?.maxMs ?? null);

  /**
   * True when there are no measured sessions yet — the honest "measuring…" state. A real 0 is NOT
   * fabricated: the beacon runs on every page, so 0 sessions means "no data yet", not "0-length visits".
   */
  readonly isEmpty = computed(
    () => !this.loading() && !this.errored() && this.resp() !== null && this.sessions() === 0,
  );

  /** The ≥30s / ≥1m / ≥3m / ≥5m distribution as labelled rows (monotonic: each is a superset of the next). */
  readonly buckets = computed<{ label: string; count: number }[]>(() => {
    const d = this.resp()?.distribution;
    if (!d || this.sessions() === 0) return [];
    return [
      { label: '≥ 30s', count: d.s30 },
      { label: '≥ 1m', count: d.s60 },
      { label: '≥ 3m', count: d.s180 },
      { label: '≥ 5m', count: d.s300 },
    ];
  });

  /** Bar width for a bucket, as a % of all sessions. Floor 2% so a tiny non-zero bucket stays visible. */
  barPct(count: number): number {
    const total = this.sessions();
    if (total <= 0 || count <= 0) return 0;
    return Math.max(2, Math.round((count / total) * 100));
  }

  /**
   * Human duration: `"—"` for null/invalid, `"45s"` under a minute, else `"2m"` / `"2m 30s"`.
   * @example formatMs(45000) // "45s"   formatMs(150000) // "2m 30s"   formatMs(null) // "—"
   */
  formatMs(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
}
