import { Component, computed, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { EmptyStateComponent, ErrorCardComponent } from '../../../components/states';

/** One key entry from GET /api/admin/kv/:binding/keys. */
interface KvKeyEntry {
  readonly name: string;
  readonly expiration?: number;
  readonly metadata?: unknown;
}
/** GET /api/admin/kv/namespaces → the server-derived binding allowlist. */
interface KvNamespacesResponse {
  readonly namespaces: readonly string[];
}
/** GET /api/admin/kv/:binding/keys → a cursor-paginated key page. */
interface KvKeysResponse {
  readonly binding: string;
  readonly keys: readonly KvKeyEntry[];
  readonly list_complete: boolean;
  readonly cursor?: string;
}
/** GET /api/admin/kv/:binding/value → one key's value + metadata + TTL. */
interface KvValueResponse {
  readonly binding: string;
  readonly key: string;
  readonly value: string | null;
  readonly metadata: unknown;
  readonly truncated: boolean;
  readonly ttl: number | null;
}

/**
 * KV Inspector — a super-admin, READ-ONLY browser for the two shared platform
 * KV namespaces (CACHE_KV, PROMPT_STORE). Consumes GET /api/admin/kv/* (feature
 * `kv_inspector`, super-admin gated → 404 when off). Binding names come from the
 * server allowlist; keys are cursor-paginated; a value panel shows value + metadata
 * + TTL with a truncation flag. KV is eventually consistent, disclosed in the UI.
 */
@Component({
  selector: 'app-kv-inspector',
  standalone: true,
  imports: [EmptyStateComponent, ErrorCardComponent],
  template: `
    <div class="px-6 pt-5 pb-8 max-md:px-4" data-testid="kv-inspector">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">KV Inspector</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-1 max-w-2xl">
        Read-only view of the shared platform KV namespaces. Super-admin only.
      </p>
      <p class="text-[0.75rem] text-amber-300/80 mb-4" data-testid="kv-eventual-note">
        Note: KV is eventually consistent — a just-written key may not appear here for a few seconds.
      </p>

      <!-- Namespace picker -->
      @if (loadingNamespaces()) {
        <p class="text-[0.82rem] text-text-secondary" role="status">Loading namespaces…</p>
      } @else if (namespaceLoadError()) {
        <app-error-card [title]="namespaceLoadError()!" (retry)="loadNamespaces()" />
      } @else if (!namespaces().length) {
        <app-empty-state title="No namespaces" message="No KV namespaces are configured for inspection." />
      } @else {
        <label for="kv-binding" class="block text-[0.78rem] font-medium text-text-secondary mb-1">
          Namespace binding
        </label>
        <select
          id="kv-binding"
          class="bg-black/30 border border-white/12 rounded-lg px-3 py-2 text-[0.85rem] text-white min-w-[220px]"
          [value]="selectedBinding() ?? ''"
          (change)="onBindingChange($event)"
          data-testid="kv-binding-select"
        >
          <option value="">Select a namespace…</option>
          @for (ns of namespaces(); track ns) {
            <option [value]="ns">{{ ns }}</option>
          }
        </select>

        @if (selectedBinding()) {
          <!-- Prefix search -->
          <form class="flex items-end gap-2 mt-4" (submit)="applyPrefix($event)">
            <div class="grow max-w-md">
              <label for="kv-prefix" class="block text-[0.78rem] font-medium text-text-secondary mb-1">
                Key prefix (optional)
              </label>
              <input
                id="kv-prefix"
                type="text"
                class="w-full bg-black/30 border border-white/12 rounded-lg px-3 py-2 text-[0.85rem] text-white"
                [value]="prefixFilter()"
                (input)="onPrefixInput($event)"
                placeholder="e.g. host:"
                data-testid="kv-prefix-input"
              />
            </div>
            <button
              type="submit"
              class="px-3 py-2 rounded-lg bg-ps-accent/90 text-black text-[0.82rem] font-semibold hover:bg-ps-accent"
              data-testid="kv-search"
            >
              Search
            </button>
          </form>

          <!-- Key list -->
          <div class="mt-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
            <section aria-label="Keys" class="min-w-0">
              @if (keysLoading() && !keys().length) {
                <p class="text-[0.82rem] text-text-secondary" role="status">Loading keys…</p>
              } @else if (keysLoadError()) {
                <app-error-card [title]="keysLoadError()!" (retry)="loadKeys()" />
              } @else if (!keys().length) {
                <app-empty-state
                  title="No keys"
                  [message]="
                    prefixFilter()
                      ? 'No keys match this prefix.'
                      : 'This namespace has no keys.'
                  "
                />
              } @else {
                <ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="kv-key-list">
                  @for (k of keys(); track k.name) {
                    <li>
                      <button
                        type="button"
                        class="w-full text-left px-3 py-1.5 rounded text-[0.82rem] font-mono truncate hover:bg-white/8"
                        [style.background]="selectedKey() === k.name ? 'rgba(255,255,255,0.10)' : null"
                        [attr.aria-pressed]="selectedKey() === k.name"
                        (click)="selectKey(k.name)"
                      >
                        {{ k.name }}
                      </button>
                    </li>
                  }
                </ul>
                @if (hasMoreKeys()) {
                  <button
                    type="button"
                    class="mt-2 text-[0.78rem] text-ps-accent hover:underline disabled:opacity-50"
                    [disabled]="keysLoading()"
                    (click)="loadMoreKeys()"
                    data-testid="kv-load-more"
                  >
                    {{ keysLoading() ? 'Loading…' : 'Load more keys' }}
                  </button>
                }
              }
            </section>

            <!-- Value panel -->
            <section aria-label="Value" class="min-w-0">
              @if (selectedKey()) {
                @if (valueLoading()) {
                  <p class="text-[0.82rem] text-text-secondary" role="status">Loading value…</p>
                } @else if (valueLoadError()) {
                  <app-error-card [title]="valueLoadError()!" (retry)="loadValue()" />
                } @else if (value(); as v) {
                  <div class="bg-black/25 border border-white/10 rounded-xl p-4" data-testid="kv-value-panel">
                    <div class="flex items-center gap-3 text-[0.72rem] text-text-secondary mb-2">
                      <span>TTL: <span class="text-white">{{ ttlLabel(v.ttl) }}</span></span>
                      @if (v.truncated) {
                        <span class="text-amber-300" data-testid="kv-truncated">truncated (64 KiB cap)</span>
                      }
                    </div>
                    @if (v.value === null) {
                      <p class="text-[0.82rem] text-text-secondary">Key not found (or has no value).</p>
                    } @else {
                      <pre
                        class="text-[0.78rem] text-white font-mono whitespace-pre-wrap break-words m-0 max-h-80 overflow-auto"
                        >{{ v.value }}</pre
                      >
                    }
                    @if (v.metadata) {
                      <div class="mt-3 pt-3 border-t border-white/8">
                        <p class="text-[0.72rem] text-text-secondary mb-1">Metadata</p>
                        <pre class="text-[0.74rem] text-text-secondary font-mono whitespace-pre-wrap break-words m-0">{{
                          metadataJson(v.metadata)
                        }}</pre>
                      </div>
                    }
                  </div>
                }
              } @else {
                <app-empty-state title="No key selected" message="Select a key to inspect its value." />
              }
            </section>
          </div>
        }
      }
    </div>
  `,
})
export class KvInspectorComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loadingNamespaces = signal(true);
  readonly namespaceLoadError = signal<string | null>(null);
  readonly namespaces = signal<readonly string[]>([]);

  readonly selectedBinding = signal<string | null>(null);
  readonly prefixFilter = signal('');

  readonly keysLoading = signal(false);
  readonly keysLoadError = signal<string | null>(null);
  readonly keys = signal<readonly KvKeyEntry[]>([]);
  private readonly listComplete = signal(true);
  private readonly cursor = signal<string | undefined>(undefined);
  readonly hasMoreKeys = computed(() => !this.listComplete());

  readonly selectedKey = signal<string | null>(null);
  readonly valueLoading = signal(false);
  readonly valueLoadError = signal<string | null>(null);
  readonly value = signal<KvValueResponse | null>(null);

  ngOnInit(): void {
    this.loadNamespaces();
  }

  loadNamespaces(): void {
    this.loadingNamespaces.set(true);
    this.namespaceLoadError.set(null);
    this.api
      .get<KvNamespacesResponse>('/admin/kv/namespaces')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.namespaces.set(Array.isArray(res?.namespaces) ? res.namespaces : []);
          this.loadingNamespaces.set(false);
        },
        error: () => {
          this.namespaceLoadError.set('Could not load KV namespaces.');
          this.loadingNamespaces.set(false);
        },
      });
  }

  onBindingChange(e: Event): void {
    this.selectBinding((e.target as HTMLSelectElement).value || null);
  }

  /** Switch the active binding, reset key state, and load its first page. */
  selectBinding(binding: string | null): void {
    this.selectedBinding.set(binding);
    this.resetKeys();
    if (binding) this.loadKeys();
  }

  onPrefixInput(e: Event): void {
    this.prefixFilter.set((e.target as HTMLInputElement).value);
  }

  /** Apply the current prefix: reset the paged list and reload from the first page. */
  applyPrefix(e?: Event): void {
    e?.preventDefault();
    this.resetKeys();
    if (this.selectedBinding()) this.loadKeys();
  }

  private resetKeys(): void {
    this.keys.set([]);
    this.listComplete.set(true);
    this.cursor.set(undefined);
    this.selectedKey.set(null);
    this.value.set(null);
    this.keysLoadError.set(null);
  }

  loadKeys(): void {
    const binding = this.selectedBinding();
    if (!binding) return;
    this.keysLoading.set(true);
    this.keysLoadError.set(null);
    const qs = new URLSearchParams();
    if (this.prefixFilter()) qs.set('prefix', this.prefixFilter());
    if (this.cursor()) qs.set('cursor', this.cursor()!);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    this.api
      .get<KvKeysResponse>(`/admin/kv/${encodeURIComponent(binding)}/keys${suffix}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.keys.set([...this.keys(), ...(res?.keys ?? [])]);
          this.listComplete.set(res?.list_complete ?? true);
          this.cursor.set(res?.cursor);
          this.keysLoading.set(false);
        },
        error: () => {
          this.keysLoadError.set('Could not load keys from this namespace.');
          this.keysLoading.set(false);
        },
      });
  }

  loadMoreKeys(): void {
    if (!this.listComplete()) this.loadKeys();
  }

  selectKey(name: string): void {
    this.selectedKey.set(name);
    this.value.set(null);
    this.loadValue();
  }

  loadValue(): void {
    const binding = this.selectedBinding();
    const key = this.selectedKey();
    if (!binding || !key) return;
    this.valueLoading.set(true);
    this.valueLoadError.set(null);
    this.api
      .get<KvValueResponse>(
        `/admin/kv/${encodeURIComponent(binding)}/value?key=${encodeURIComponent(key)}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.value.set(res ?? null);
          this.valueLoading.set(false);
        },
        error: () => {
          this.valueLoadError.set('Could not load the value for this key.');
          this.valueLoading.set(false);
        },
      });
  }

  /** Human-readable TTL. `null` = no expiry; otherwise coarse seconds→d/h/m/s. */
  ttlLabel(ttl: number | null): string {
    if (ttl == null) return 'No expiry';
    if (ttl <= 0) return 'Expired';
    if (ttl < 60) return `${ttl}s`;
    if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
    if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
    return `${Math.round(ttl / 86400)}d`;
  }

  /** Pretty-print metadata for display; falls back to String() on cyclic data. */
  metadataJson(meta: unknown): string {
    try {
      return JSON.stringify(meta, null, 2);
    } catch {
      return String(meta);
    }
  }
}
