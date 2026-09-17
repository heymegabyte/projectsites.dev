import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { MetaService } from '../../services/meta.service';

/**
 * Public product roadmap (`/roadmap`) — a Trello-style board grouped by status,
 * backed by `GET /api/public/roadmap` (worker `src/routes/public.ts`). The API +
 * the MetaService `roadmap` entry + the changelog announcement all pre-existed;
 * only this route/component was missing, so `/roadmap` soft-404'd to the
 * not-found page. This wires the promised page to its live data source.
 *
 * Standalone · OnPush · signals only. Errors surface via the `error` signal
 * (recoverable state, never a thrown blank). The board is a responsive grid
 * (1 col mobile → 3 col ≥768px) so it reflows cleanly at 320/390px (WCAG 1.4.10);
 * all text clears WCAG AA contrast on the dark theme (slate `#94a3b8` = 7.7:1,
 * never the `#64748b` = 4.23:1 that fails). Exactly one `<h1>`.
 */
interface RoadmapItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'shipped' | 'in_progress' | 'planned';
  readonly quarter: string;
}
interface RoadmapResponse {
  readonly quarters: readonly { readonly quarter: string; readonly items: readonly RoadmapItem[] }[];
}
interface Column {
  readonly status: RoadmapItem['status'];
  readonly label: string;
  readonly items: readonly RoadmapItem[];
}

/** Left-to-right progression: what's next → in flight → done. */
const COLUMN_DEFS: readonly { status: RoadmapItem['status']; label: string }[] = [
  { status: 'planned', label: 'Planned' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'shipped', label: 'Shipped' },
];

@Component({
  selector: 'app-roadmap',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <main class="rm-wrap">
      <header class="rm-head">
        <a routerLink="/" class="rm-back">&larr; Home</a>
        <h1 class="rm-title">Product Roadmap</h1>
        <p class="rm-sub">
          What we've shipped, what's in flight, and what's next — a live view of where ProjectSites is going.
        </p>
        @if (!loading() && !error()) {
          <div class="rm-stats">
            <span class="rm-stat"><strong>{{ shippedCount() }}</strong> shipped</span>
            <span class="rm-stat"><strong>{{ total() }}</strong> total</span>
          </div>
        }
      </header>

      @if (loading()) {
        <div class="rm-board" aria-busy="true" aria-label="Loading roadmap">
          @for (n of [1, 2, 3]; track n) {
            <div class="rm-col"><div class="rm-skel"></div><div class="rm-skel"></div></div>
          }
        </div>
      } @else if (error()) {
        <div class="rm-error" role="alert">
          <p>{{ error() }}</p>
          <a routerLink="/" class="rm-cta">Back to home</a>
        </div>
      } @else {
        <div class="rm-board" role="list" aria-label="Product roadmap by status">
          @for (col of columns(); track col.status) {
            <section class="rm-col" [attr.data-status]="col.status" role="listitem">
              <h2 class="rm-col-head">
                {{ col.label }} <span class="rm-count">{{ col.items.length }}</span>
              </h2>
              @if (col.items.length === 0) {
                <p class="rm-empty">Nothing here yet.</p>
              } @else {
                @for (item of col.items; track item.id) {
                  <article class="rm-card">
                    <h3 class="rm-card-title">{{ item.title }}</h3>
                    <p class="rm-card-desc">{{ item.description }}</p>
                    <span class="rm-chip">{{ item.quarter }}</span>
                  </article>
                }
              }
            </section>
          }
        </div>
      }
    </main>
  `,
  styles: [
    `
      :host { display: block; background: #060610; min-height: 100vh; }
      .rm-wrap { max-width: 1120px; margin: 0 auto; padding: 4rem 1.25rem 6rem; color: #f4f4ff; }
      .rm-back { color: #00e5ff; font-size: 0.85rem; text-decoration: none; }
      .rm-back:hover { text-decoration: underline; }
      .rm-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: clamp(2rem, 5vw, 3rem);
        font-weight: 800;
        line-height: 1.1;
        margin: 1rem 0 0.6rem;
        text-wrap: balance;
      }
      .rm-sub { color: #94a3b8; max-width: 44rem; line-height: 1.6; margin: 0; }
      .rm-stats { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-top: 1.5rem; }
      .rm-stat { color: #94a3b8; font-size: 0.85rem; }
      .rm-stat strong { color: #00e5ff; font-size: 1.15rem; font-weight: 700; }
      .rm-board { display: grid; grid-template-columns: 1fr; gap: 1.25rem; margin-top: 2.75rem; }
      @media (min-width: 768px) { .rm-board { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
      .rm-col {
        min-width: 0;
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 16px;
        padding: 1.1rem;
      }
      .rm-col-head {
        display: flex; align-items: center; gap: 0.5rem;
        font-family: 'Space Grotesk', system-ui, sans-serif;
        font-size: 0.85rem; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.06em;
        color: #cbd5e1; margin: 0 0 1rem;
      }
      .rm-col[data-status='shipped'] .rm-col-head { color: #00e5ff; }
      .rm-col[data-status='in_progress'] .rm-col-head { color: #50aae3; }
      .rm-count {
        background: rgba(0, 229, 255, 0.12); color: #00e5ff;
        font-size: 0.7rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 999px;
      }
      .rm-card {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px; padding: 0.95rem; margin-bottom: 0.75rem;
        transition: border-color 0.2s ease, transform 0.2s ease;
      }
      .rm-card:hover { border-color: rgba(0, 229, 255, 0.3); transform: translateY(-2px); }
      .rm-card-title { font-size: 0.98rem; font-weight: 600; margin: 0 0 0.45rem; line-height: 1.3; }
      .rm-card-desc { color: #94a3b8; font-size: 0.82rem; line-height: 1.55; margin: 0 0 0.7rem; }
      .rm-chip {
        display: inline-block; font-size: 0.68rem; color: #94a3b8;
        background: rgba(255, 255, 255, 0.05); padding: 0.18rem 0.55rem; border-radius: 6px;
      }
      .rm-empty { color: #94a3b8; font-size: 0.82rem; font-style: italic; margin: 0; }
      .rm-skel {
        height: 76px; border-radius: 12px; margin-bottom: 0.75rem;
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.03));
        background-size: 200% 100%; animation: rm-shimmer 1.4s ease-in-out infinite;
      }
      @keyframes rm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      @media (prefers-reduced-motion: reduce) { .rm-skel { animation: none; } .rm-card { transition: none; } }
      .rm-error { text-align: center; padding: 4rem 1rem; color: #94a3b8; }
      .rm-error p { margin: 0 0 1rem; }
      .rm-cta { color: #00e5ff; font-weight: 600; text-decoration: none; }
      .rm-cta:hover { text-decoration: underline; }
    `,
  ],
})
export class RoadmapComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly meta = inject(MetaService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal<boolean>(true);
  protected readonly error = signal<string | null>(null);
  protected readonly response = signal<RoadmapResponse | null>(null);

  /** Flatten every quarter's items and bucket them into the status columns. */
  protected readonly columns = computed<readonly Column[]>(() => {
    const data = this.response();
    if (!data) return [];
    const all = data.quarters.flatMap((q) => q.items);
    return COLUMN_DEFS.map((c) => ({ ...c, items: all.filter((i) => i.status === c.status) }));
  });
  protected readonly total = computed<number>(
    () => this.response()?.quarters.reduce((n, q) => n + q.items.length, 0) ?? 0,
  );
  protected readonly shippedCount = computed<number>(
    () => this.columns().find((c) => c.status === 'shipped')?.items.length ?? 0,
  );

  ngOnInit(): void {
    this.meta.init();
    this.http.get<RoadmapResponse>('/api/public/roadmap').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => {
        this.response.set(data);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load roadmap';
        console.warn('[roadmap] fetch failed:', message);
        this.error.set('Could not load the roadmap right now. Please refresh.');
        this.loading.set(false);
      },
    });
  }
}
