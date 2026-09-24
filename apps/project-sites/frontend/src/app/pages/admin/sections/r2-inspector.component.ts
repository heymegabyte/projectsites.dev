import { Component, computed, signal, inject, DestroyRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../../services/api.service';
import { EmptyStateComponent, ErrorCardComponent } from '../../../components/states';

/** One object entry from GET /api/admin/r2/:bucket/objects. */
interface R2ObjectEntry {
  readonly key: string;
  readonly size: number;
  readonly uploaded: string | null;
  readonly etag: string;
  readonly contentType: string | null;
}
/** GET /api/admin/r2/buckets → the server-derived bucket allowlist. */
interface R2BucketsResponse {
  readonly buckets: readonly string[];
}
/** GET /api/admin/r2/:bucket/objects → a cursor-paginated object page. */
interface R2ObjectsResponse {
  readonly bucket: string;
  readonly objects: readonly R2ObjectEntry[];
  readonly truncated: boolean;
  readonly cursor?: string;
}
/** GET /api/admin/r2/:bucket/object → one object's metadata (HEAD, never the body). */
interface R2ObjectResponse {
  readonly bucket: string;
  readonly key: string;
  readonly found: boolean;
  readonly size: number | null;
  readonly uploaded: string | null;
  readonly etag: string | null;
  readonly contentType: string | null;
  readonly customMetadata: unknown;
}

/**
 * R2 Inspector — a super-admin, READ-ONLY browser for the shared platform R2
 * bucket (SITES_BUCKET). Consumes GET /api/admin/r2/* (feature `r2_inspector`,
 * super-admin gated → 404 when off). Buckets come from the server allowlist;
 * objects are prefix + cursor-paginated; the detail panel shows an object's
 * metadata (size / uploaded / content-type / etag / custom metadata) via HEAD —
 * the object BODY is never fetched here.
 */
@Component({
  selector: 'app-r2-inspector',
  standalone: true,
  imports: [EmptyStateComponent, ErrorCardComponent],
  template: `
    <div class="px-6 pt-5 pb-8 max-md:px-4" data-testid="r2-inspector">
      <h1 class="text-[1.35rem] font-extrabold text-white tracking-tight m-0">R2 Inspector</h1>
      <p class="text-[0.82rem] text-text-secondary mt-1 mb-1 max-w-2xl">
        Read-only view of the shared platform R2 bucket (generated sites + media). Super-admin only.
      </p>
      <p class="text-[0.75rem] text-amber-300/80 mb-4" data-testid="r2-metadata-note">
        Note: metadata only — object contents (bodies) are never downloaded here.
      </p>

      <!-- Bucket picker -->
      @if (loadingBuckets()) {
        <p class="text-[0.82rem] text-text-secondary" role="status">Loading buckets…</p>
      } @else if (bucketLoadError()) {
        <app-error-card [title]="bucketLoadError()!" (retry)="loadBuckets()" />
      } @else if (!buckets().length) {
        <app-empty-state
          title="No buckets"
          message="No R2 buckets are configured for inspection."
        />
      } @else {
        <label for="r2-bucket" class="block text-[0.78rem] font-medium text-text-secondary mb-1">
          Bucket binding
        </label>
        <select
          id="r2-bucket"
          class="bg-black/30 border border-white/12 rounded-lg px-3 py-2 text-[0.85rem] text-white min-w-[220px]"
          [value]="selectedBucket() ?? ''"
          (change)="onBucketChange($event)"
          data-testid="r2-bucket-select"
        >
          <option value="">Select a bucket…</option>
          @for (b of buckets(); track b) {
            <option [value]="b">{{ b }}</option>
          }
        </select>

        @if (selectedBucket()) {
          <!-- Prefix search -->
          <form class="flex items-end gap-2 mt-4" (submit)="applyPrefix($event)">
            <div class="grow max-w-md">
              <label
                for="r2-prefix"
                class="block text-[0.78rem] font-medium text-text-secondary mb-1"
              >
                Key prefix (optional)
              </label>
              <input
                id="r2-prefix"
                type="text"
                class="w-full bg-black/30 border border-white/12 rounded-lg px-3 py-2 text-[0.85rem] text-white"
                [value]="prefixFilter()"
                (input)="onPrefixInput($event)"
                placeholder="e.g. sites/"
                data-testid="r2-prefix-input"
              />
            </div>
            <button
              type="submit"
              class="px-3 py-2 rounded-lg bg-ps-accent/90 text-black text-[0.82rem] font-semibold hover:bg-ps-accent"
              data-testid="r2-search"
            >
              Search
            </button>
          </form>

          <!-- Object list -->
          <div class="mt-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
            <section aria-label="Objects" class="min-w-0">
              @if (objectsLoading() && !objects().length) {
                <p class="text-[0.82rem] text-text-secondary" role="status">Loading objects…</p>
              } @else if (objectsLoadError()) {
                <app-error-card [title]="objectsLoadError()!" (retry)="loadObjects()" />
              } @else if (!objects().length) {
                <app-empty-state
                  title="No objects"
                  [message]="
                    prefixFilter() ? 'No objects match this prefix.' : 'This bucket has no objects.'
                  "
                />
              } @else {
                <ul class="flex flex-col gap-0.5 m-0 p-0 list-none" data-testid="r2-object-list">
                  @for (o of objects(); track o.key) {
                    <li>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 text-left px-3 py-1.5 rounded hover:bg-white/8"
                        [style.background]="
                          selectedKey() === o.key ? 'rgba(255,255,255,0.10)' : null
                        "
                        [attr.aria-pressed]="selectedKey() === o.key"
                        (click)="selectObject(o.key)"
                      >
                        <span class="text-[0.82rem] font-mono truncate grow min-w-0">{{
                          o.key
                        }}</span>
                        <span class="text-[0.7rem] text-text-secondary shrink-0 tabular-nums">{{
                          sizeLabel(o.size)
                        }}</span>
                      </button>
                    </li>
                  }
                </ul>
                @if (hasMore()) {
                  <button
                    type="button"
                    class="mt-2 text-[0.78rem] text-ps-accent hover:underline disabled:opacity-50"
                    [disabled]="objectsLoading()"
                    (click)="loadMore()"
                    data-testid="r2-load-more"
                  >
                    {{ objectsLoading() ? 'Loading…' : 'Load more objects' }}
                  </button>
                }
              }
            </section>

            <!-- Object metadata panel -->
            <section aria-label="Object" class="min-w-0">
              @if (selectedKey()) {
                @if (objLoading()) {
                  <p class="text-[0.82rem] text-text-secondary" role="status">Loading object…</p>
                } @else if (objLoadError()) {
                  <app-error-card [title]="objLoadError()!" (retry)="loadObject()" />
                } @else if (obj(); as o) {
                  <div
                    class="bg-black/25 border border-white/10 rounded-xl p-4"
                    data-testid="r2-object-panel"
                  >
                    @if (!o.found) {
                      <p class="text-[0.82rem] text-text-secondary">Object not found.</p>
                    } @else {
                      <dl
                        class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[0.78rem]"
                      >
                        <dt class="text-text-secondary">Key</dt>
                        <dd class="text-white font-mono break-all m-0">{{ o.key }}</dd>
                        <dt class="text-text-secondary">Size</dt>
                        <dd class="text-white m-0">{{ sizeLabel(o.size) }}</dd>
                        <dt class="text-text-secondary">Uploaded</dt>
                        <dd class="text-white m-0">{{ dateLabel(o.uploaded) }}</dd>
                        <dt class="text-text-secondary">Content-Type</dt>
                        <dd class="text-white m-0">{{ o.contentType ?? '—' }}</dd>
                        <dt class="text-text-secondary">ETag</dt>
                        <dd class="text-white font-mono break-all m-0">{{ o.etag ?? '—' }}</dd>
                      </dl>
                      @if (o.customMetadata && hasKeys(o.customMetadata)) {
                        <div class="mt-3 pt-3 border-t border-white/8">
                          <p class="text-[0.72rem] text-text-secondary mb-1">Custom metadata</p>
                          <pre
                            class="text-[0.74rem] text-text-secondary font-mono whitespace-pre-wrap break-words m-0"
                            >{{ metadataJson(o.customMetadata) }}</pre>
                        </div>
                      }
                    }
                  </div>
                }
              } @else {
                <app-empty-state
                  title="No object selected"
                  message="Select an object to inspect its metadata."
                />
              }
            </section>
          </div>
        }
      }
    </div>
  `,
})
export class R2InspectorComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loadingBuckets = signal(true);
  readonly bucketLoadError = signal<string | null>(null);
  readonly buckets = signal<readonly string[]>([]);

  readonly selectedBucket = signal<string | null>(null);
  readonly prefixFilter = signal('');

  readonly objectsLoading = signal(false);
  readonly objectsLoadError = signal<string | null>(null);
  readonly objects = signal<readonly R2ObjectEntry[]>([]);
  private readonly truncated = signal(false);
  private readonly cursor = signal<string | undefined>(undefined);
  readonly hasMore = computed(() => this.truncated());

  readonly selectedKey = signal<string | null>(null);
  readonly objLoading = signal(false);
  readonly objLoadError = signal<string | null>(null);
  readonly obj = signal<R2ObjectResponse | null>(null);

  ngOnInit(): void {
    this.loadBuckets();
  }

  loadBuckets(): void {
    this.loadingBuckets.set(true);
    this.bucketLoadError.set(null);
    this.api
      .get<R2BucketsResponse>('/admin/r2/buckets')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.buckets.set(Array.isArray(res?.buckets) ? res.buckets : []);
          this.loadingBuckets.set(false);
        },
        error: () => {
          this.bucketLoadError.set('Could not load R2 buckets.');
          this.loadingBuckets.set(false);
        },
      });
  }

  onBucketChange(e: Event): void {
    this.selectBucket((e.target as HTMLSelectElement).value || null);
  }

  /** Switch the active bucket, reset object state, and load its first page. */
  selectBucket(bucket: string | null): void {
    this.selectedBucket.set(bucket);
    this.resetObjects();
    if (bucket) this.loadObjects();
  }

  onPrefixInput(e: Event): void {
    this.prefixFilter.set((e.target as HTMLInputElement).value);
  }

  /** Apply the current prefix: reset the paged list and reload from the first page. */
  applyPrefix(e?: Event): void {
    e?.preventDefault();
    this.resetObjects();
    if (this.selectedBucket()) this.loadObjects();
  }

  private resetObjects(): void {
    this.objects.set([]);
    this.truncated.set(false);
    this.cursor.set(undefined);
    this.selectedKey.set(null);
    this.obj.set(null);
    this.objectsLoadError.set(null);
  }

  loadObjects(): void {
    const bucket = this.selectedBucket();
    if (!bucket) return;
    this.objectsLoading.set(true);
    this.objectsLoadError.set(null);
    const qs = new URLSearchParams();
    if (this.prefixFilter()) qs.set('prefix', this.prefixFilter());
    if (this.cursor()) qs.set('cursor', this.cursor()!);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    this.api
      .get<R2ObjectsResponse>(`/admin/r2/${encodeURIComponent(bucket)}/objects${suffix}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.objects.set([...this.objects(), ...(res?.objects ?? [])]);
          this.truncated.set(res?.truncated ?? false);
          this.cursor.set(res?.cursor);
          this.objectsLoading.set(false);
        },
        error: () => {
          this.objectsLoadError.set('Could not load objects from this bucket.');
          this.objectsLoading.set(false);
        },
      });
  }

  loadMore(): void {
    if (this.truncated()) this.loadObjects();
  }

  selectObject(key: string): void {
    this.selectedKey.set(key);
    this.obj.set(null);
    this.loadObject();
  }

  loadObject(): void {
    const bucket = this.selectedBucket();
    const key = this.selectedKey();
    if (!bucket || !key) return;
    this.objLoading.set(true);
    this.objLoadError.set(null);
    this.api
      .get<R2ObjectResponse>(
        `/admin/r2/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`,
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.obj.set(res ?? null);
          this.objLoading.set(false);
        },
        error: () => {
          this.objLoadError.set('Could not load the metadata for this object.');
          this.objLoading.set(false);
        },
      });
  }

  /** Human-readable byte size. `null` → em dash. */
  sizeLabel(bytes: number | null): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /** Render the stored UTC upload timestamp honestly (no local-tz shift). */
  dateLabel(iso: string | null): string {
    if (!iso) return '—';
    return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
  }

  /** True when a metadata object has at least one own key (so we don't render an empty block). */
  hasKeys(meta: unknown): boolean {
    return !!meta && typeof meta === 'object' && Object.keys(meta as object).length > 0;
  }

  /** Pretty-print custom metadata for display; falls back to String() on cyclic data. */
  metadataJson(meta: unknown): string {
    try {
      return JSON.stringify(meta, null, 2);
    } catch {
      return String(meta);
    }
  }
}
