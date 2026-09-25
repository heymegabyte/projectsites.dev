import { Component, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { EmptyStateComponent, ErrorCardComponent } from '../../../components/states';

/** One queue row from GET /api/admin/queues. */
interface QueueEntry {
  readonly id: string;
  readonly name: string;
  readonly producers: number;
  readonly consumers: number;
  readonly created: string | null;
  readonly modified: string | null;
}
/** GET /api/admin/queues → the queue list + honest availability flag. */
interface QueuesResponse {
  readonly queues: readonly QueueEntry[];
  readonly available: boolean;
  readonly reason?: string;
}
/** One producer/consumer binding. */
interface QueueEndpoint {
  readonly type: string;
  readonly script: string | null;
}
/** GET /api/admin/queues/:id → one queue's settings + producers/consumers. */
interface QueueDetail {
  readonly found: boolean;
  readonly id: string;
  readonly name: string;
  readonly created: string | null;
  readonly modified: string | null;
  readonly settings: { deliveryDelaySeconds: number | null; messageRetentionSeconds: number | null };
  readonly producers: readonly QueueEndpoint[];
  readonly consumers: readonly QueueEndpoint[];
  readonly available?: boolean;
}

/**
 * Queues Inspector — a super-admin, READ-ONLY view of the account's Cloudflare Queues
 * (job / workflow pipelines — shared platform infra). Consumes GET /api/admin/queues/*
 * (feature `queues_inspector`, super-admin gated → 404 when off). Lists queues; selecting
 * one shows its settings (delivery delay, message retention) + the producers and consumers
 * (worker script / service) bound to it. No messages are published, consumed, or purged
 * here. An honest "not available" notice distinguishes a Cloudflare credential/API issue
 * from a genuinely empty account (never a fabricated empty list).
 */
@Component({
  selector: 'app-queues-inspector',
  standalone: true,
  imports: [EmptyStateComponent, ErrorCardComponent],
  template: `
    <div class="px-6 pt-5 pb-8 max-md:px-4" data-testid="queues-inspector">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">Queues Inspector</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-1 max-w-2xl">
        Read-only view of the account's Cloudflare Queues (job / workflow pipelines — shared
        platform infra). Super-admin only.
      </p>
      <p class="text-[0.75rem] text-amber-300/80 mb-4" data-testid="queues-readonly-note">
        Note: queue metadata only — no messages are published, consumed, or purged here.
      </p>

      @if (loading()) {
        <p class="text-[0.82rem] text-text-secondary" role="status">Loading queues…</p>
      } @else if (loadError()) {
        <app-error-card [title]="loadError()!" (retry)="loadQueues()" />
      } @else if (!available()) {
        <div
          class="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[0.82rem] text-amber-100/90"
          role="status"
          data-testid="queues-unavailable"
        >
          Queue data isn't available right now (Cloudflare credentials or API). This is a read-only
          debug view — retry once credentials/API are reachable.
        </div>
      } @else if (!queues().length) {
        <app-empty-state title="No queues" message="This account has no Cloudflare Queues yet." />
      } @else {
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
          <section aria-label="Queues" class="min-w-0">
            <ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="queues-list">
              @for (q of queues(); track q.id) {
                <li>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 text-left px-3 py-1.5 rounded hover:bg-white/8"
                    [style.background]="selectedId() === q.id ? 'rgba(255,255,255,0.10)' : null"
                    [attr.aria-pressed]="selectedId() === q.id"
                    (click)="selectQueue(q.id)"
                  >
                    <span class="text-[0.85rem] font-mono truncate grow min-w-0">{{ q.name }}</span>
                    <span class="text-[0.7rem] text-text-secondary shrink-0 tabular-nums">
                      {{ q.producers }}p · {{ q.consumers }}c
                    </span>
                  </button>
                </li>
              }
            </ul>
          </section>

          <section aria-label="Queue" class="min-w-0">
            @if (selectedId()) {
              @if (detailLoading()) {
                <p class="text-[0.82rem] text-text-secondary" role="status">Loading queue…</p>
              } @else if (detailError()) {
                <app-error-card [title]="detailError()!" (retry)="loadDetail()" />
              } @else if (detail(); as d) {
                <div class="bg-black/25 border border-white/10 rounded-xl p-4" data-testid="queue-panel">
                  @if (!d.found) {
                    <p class="text-[0.82rem] text-text-secondary">Queue not found.</p>
                  } @else {
                    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.78rem]">
                      <dt class="text-text-secondary">Name</dt>
                      <dd class="text-white font-mono break-all m-0">{{ d.name }}</dd>
                      <dt class="text-text-secondary">Message retention</dt>
                      <dd class="text-white m-0">{{ durationLabel(d.settings.messageRetentionSeconds) }}</dd>
                      <dt class="text-text-secondary">Delivery delay</dt>
                      <dd class="text-white m-0">{{ durationLabel(d.settings.deliveryDelaySeconds) }}</dd>
                      <dt class="text-text-secondary">Created</dt>
                      <dd class="text-white m-0">{{ dateLabel(d.created) }}</dd>
                      <dt class="text-text-secondary">Modified</dt>
                      <dd class="text-white m-0">{{ dateLabel(d.modified) }}</dd>
                    </dl>
                    <div class="mt-3 pt-3 border-t border-white/8">
                      <p class="text-[0.72rem] text-text-secondary mb-1">Producers ({{ d.producers.length }})</p>
                      @if (d.producers.length) {
                        <ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="queue-producers">
                          @for (p of d.producers; track p.script) {
                            <li class="text-[0.76rem] text-white font-mono">{{ p.script ?? '—' }} <span class="text-text-secondary">({{ p.type }})</span></li>
                          }
                        </ul>
                      } @else {
                        <p class="text-[0.74rem] text-text-secondary m-0">None.</p>
                      }
                    </div>
                    <div class="mt-3 pt-3 border-t border-white/8">
                      <p class="text-[0.72rem] text-text-secondary mb-1">Consumers ({{ d.consumers.length }})</p>
                      @if (d.consumers.length) {
                        <ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="queue-consumers">
                          @for (cn of d.consumers; track cn.script) {
                            <li class="text-[0.76rem] text-white font-mono">{{ cn.script ?? '—' }} <span class="text-text-secondary">({{ cn.type }})</span></li>
                          }
                        </ul>
                      } @else {
                        <p class="text-[0.74rem] text-text-secondary m-0">None.</p>
                      }
                    </div>
                  }
                </div>
              }
            } @else {
              <app-empty-state
                title="No queue selected"
                message="Select a queue to inspect its settings and bindings."
              />
            }
          </section>
        </div>
      }
    </div>
  `,
})
export class QueuesInspectorComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly available = signal(true);
  readonly queues = signal<readonly QueueEntry[]>([]);

  readonly selectedId = signal<string | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly detail = signal<QueueDetail | null>(null);

  ngOnInit(): void {
    this.loadQueues();
  }

  loadQueues(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .get<QueuesResponse>('/admin/queues')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.available.set(res?.available ?? false);
          this.queues.set(Array.isArray(res?.queues) ? res.queues : []);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set('Could not load Cloudflare Queues.');
          this.loading.set(false);
        },
      });
  }

  selectQueue(id: string): void {
    this.selectedId.set(id);
    this.detail.set(null);
    this.loadDetail();
  }

  loadDetail(): void {
    const id = this.selectedId();
    if (!id) return;
    this.detailLoading.set(true);
    this.detailError.set(null);
    this.api
      .get<QueueDetail>(`/admin/queues/${encodeURIComponent(id)}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.detail.set(res ?? null);
          this.detailLoading.set(false);
        },
        error: () => {
          this.detailError.set('Could not load this queue.');
          this.detailLoading.set(false);
        },
      });
  }

  /** Human-readable duration from seconds (queue retention/delay); null → em dash. */
  durationLabel(seconds: number | null): string {
    if (seconds == null) return '—';
    if (seconds === 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
  }

  /** Render a stored UTC timestamp honestly (no local-tz shift); null → em dash. */
  dateLabel(iso: string | null): string {
    if (!iso) return '—';
    return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
  }
}
