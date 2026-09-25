import { Component, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { EmptyStateComponent, ErrorCardComponent } from '../../../components/states';

/** One index row from GET /api/admin/vectorize/indexes. */
interface VectorizeIndexEntry {
  readonly name: string;
  readonly dimensions: number | null;
  readonly metric: string | null;
  readonly description: string | null;
  readonly created: string | null;
  readonly modified: string | null;
}
/** GET /api/admin/vectorize/indexes → the index list + honest availability flag. */
interface VectorizeIndexesResponse {
  readonly indexes: readonly VectorizeIndexEntry[];
  readonly available: boolean;
  readonly reason?: string;
}
/** GET /api/admin/vectorize/indexes/:name → one index's config + vector count. */
interface VectorizeIndexDetail {
  readonly found: boolean;
  readonly name: string;
  readonly dimensions: number | null;
  readonly metric: string | null;
  readonly description: string | null;
  readonly created: string | null;
  readonly modified: string | null;
  readonly vectorCount: number | null;
  readonly processedUpToMutation: string | null;
  readonly available?: boolean;
}

/**
 * Vectorize Inspector — a super-admin, READ-ONLY view of the account's Cloudflare
 * Vectorize indexes (RAG / embeddings — shared platform infra). Consumes GET
 * /api/admin/vectorize/* (feature `vectorize_inspector`, super-admin gated → 404 when
 * off). Lists indexes; selecting one shows its config (dimensions, distance metric,
 * description, timestamps) + vector count. No vectors are queried, inserted, or deleted
 * here. An honest "not available" notice distinguishes a Cloudflare credential/API issue
 * from a genuinely empty account (never a fabricated empty list).
 */
@Component({
  selector: 'app-vectorize-inspector',
  standalone: true,
  imports: [EmptyStateComponent, ErrorCardComponent],
  template: `
    <div class="px-6 pt-5 pb-8 max-md:px-4" data-testid="vectorize-inspector">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">Vectorize Inspector</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-1 max-w-2xl">
        Read-only view of the account's Cloudflare Vectorize indexes (RAG / embeddings — shared
        platform infra). Super-admin only.
      </p>
      <p class="text-[0.75rem] text-amber-300/80 mb-4" data-testid="vectorize-readonly-note">
        Note: index metadata only — no vectors are queried, inserted, or deleted here.
      </p>

      @if (loading()) {
        <p class="text-[0.82rem] text-text-secondary" role="status">Loading indexes…</p>
      } @else if (loadError()) {
        <app-error-card [title]="loadError()!" (retry)="loadIndexes()" />
      } @else if (!available()) {
        <!-- Honest: a CF credential/API failure — NOT a fabricated "0 indexes". -->
        <div
          class="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[0.82rem] text-amber-100/90"
          role="status"
          data-testid="vectorize-unavailable"
        >
          Vectorize index data isn't available right now (Cloudflare credentials or API). This is a
          read-only debug view — retry once credentials/API are reachable.
        </div>
      } @else if (!indexes().length) {
        <app-empty-state
          title="No Vectorize indexes"
          message="This account has no Vectorize indexes yet."
        />
      } @else {
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
          <!-- Index list -->
          <section aria-label="Indexes" class="min-w-0">
            <ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="vectorize-index-list">
              @for (i of indexes(); track i.name) {
                <li>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 text-left px-3 py-1.5 rounded hover:bg-white/8"
                    [style.background]="selectedName() === i.name ? 'rgba(255,255,255,0.10)' : null"
                    [attr.aria-pressed]="selectedName() === i.name"
                    (click)="selectIndex(i.name)"
                  >
                    <span class="text-[0.85rem] font-mono truncate grow min-w-0">{{ i.name }}</span>
                    <span class="text-[0.7rem] text-text-secondary shrink-0 tabular-nums">
                      {{ i.dimensions ?? '?' }}d · {{ i.metric ?? '—' }}
                    </span>
                  </button>
                </li>
              }
            </ul>
          </section>

          <!-- Index detail panel -->
          <section aria-label="Index" class="min-w-0">
            @if (selectedName()) {
              @if (detailLoading()) {
                <p class="text-[0.82rem] text-text-secondary" role="status">Loading index…</p>
              } @else if (detailError()) {
                <app-error-card [title]="detailError()!" (retry)="loadDetail()" />
              } @else if (detail(); as d) {
                <div class="bg-black/25 border border-white/10 rounded-xl p-4" data-testid="vectorize-index-panel">
                  @if (!d.found) {
                    <p class="text-[0.82rem] text-text-secondary">Index not found.</p>
                  } @else {
                    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.78rem]">
                      <dt class="text-text-secondary">Name</dt>
                      <dd class="text-white font-mono break-all m-0">{{ d.name }}</dd>
                      <dt class="text-text-secondary">Dimensions</dt>
                      <dd class="text-white m-0">{{ d.dimensions ?? '—' }}</dd>
                      <dt class="text-text-secondary">Distance metric</dt>
                      <dd class="text-white m-0">{{ d.metric ?? '—' }}</dd>
                      <dt class="text-text-secondary">Vectors</dt>
                      <dd class="text-white m-0 tabular-nums" data-testid="vectorize-vector-count">
                        {{ d.vectorCount != null ? countLabel(d.vectorCount) : '—' }}
                      </dd>
                      <dt class="text-text-secondary">Description</dt>
                      <dd class="text-white m-0">{{ d.description || '—' }}</dd>
                      <dt class="text-text-secondary">Created</dt>
                      <dd class="text-white m-0">{{ dateLabel(d.created) }}</dd>
                      <dt class="text-text-secondary">Modified</dt>
                      <dd class="text-white m-0">{{ dateLabel(d.modified) }}</dd>
                      @if (d.processedUpToMutation) {
                        <dt class="text-text-secondary">Last processed</dt>
                        <dd class="text-white font-mono break-all m-0">{{ d.processedUpToMutation }}</dd>
                      }
                    </dl>
                  }
                </div>
              }
            } @else {
              <app-empty-state
                title="No index selected"
                message="Select an index to inspect its configuration and vector count."
              />
            }
          </section>
        </div>
      }
    </div>
  `,
})
export class VectorizeInspectorComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly available = signal(true);
  readonly indexes = signal<readonly VectorizeIndexEntry[]>([]);

  readonly selectedName = signal<string | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly detail = signal<VectorizeIndexDetail | null>(null);

  ngOnInit(): void {
    this.loadIndexes();
  }

  loadIndexes(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .get<VectorizeIndexesResponse>('/admin/vectorize/indexes')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.available.set(res?.available ?? false);
          this.indexes.set(Array.isArray(res?.indexes) ? res.indexes : []);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set('Could not load Vectorize indexes.');
          this.loading.set(false);
        },
      });
  }

  selectIndex(name: string): void {
    this.selectedName.set(name);
    this.detail.set(null);
    this.loadDetail();
  }

  loadDetail(): void {
    const name = this.selectedName();
    if (!name) return;
    this.detailLoading.set(true);
    this.detailError.set(null);
    this.api
      .get<VectorizeIndexDetail>(`/admin/vectorize/indexes/${encodeURIComponent(name)}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.detail.set(res ?? null);
          this.detailLoading.set(false);
        },
        error: () => {
          this.detailError.set('Could not load this index.');
          this.detailLoading.set(false);
        },
      });
  }

  /** Thousands-separated vector count. */
  countLabel(n: number): string {
    return n.toLocaleString('en-US');
  }

  /** Render a stored UTC timestamp honestly (no local-tz shift); null → em dash. */
  dateLabel(iso: string | null): string {
    if (!iso) return '—';
    return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
  }
}
