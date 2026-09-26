/**
 * @module services/bolt-embed
 *
 * @description
 * Owns the lifecycle of the bolt.diy (`editor.projectsites.dev`) iframe so it
 * survives Angular route changes inside `/admin/*`. Without this, every
 * navigation between admin sub-routes destroys + re-mounts the iframe and
 * pays the WebContainer cold-boot tax (~30-60s) again.
 *
 * Architecture:
 * - The iframe element lives inside `AdminComponent`'s template (one
 *   stable parent across all sub-routes).
 * - `AdminEditorComponent` is now a *visibility shell* — it tells the
 *   service to show/hide the iframe and renders the loading veil while
 *   the iframe is still booting.
 * - Pre-boot: as soon as `AdminStateService.selectedSite()` resolves, we
 *   call {@link bootForSite} to start downloading bolt.diy + WebContainer
 *   in the background — even when the user is still on `/admin/forms` or
 *   `/admin/billing`. By the time they click "Editor" the iframe is
 *   already running.
 * - Postmessage protocol mirrors the previous in-component handler
 *   (PS_BOLT_READY / PS_BOLT_FILES_LOADED / PS_APP_RUNNING / PS_FILES_READY /
 *   PS_GENERATION_STATUS).
 */

import { Injectable, effect, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from './api.service';
import { ToastService } from './toast.service';

const HARD_TIMEOUT_MS = 90_000; // absolute cap — a cold WebContainer boot + npm install can run ~60s
const CHAT_GRACE_MS = 10_000; // after the chat paints, wait this long for the true preview-ready signal before dismissing
const SAVE_TIMEOUT_MS = 30_000;
const EDITOR_BASE = 'https://editor.projectsites.dev';
const ALLOWED_ORIGINS = ['https://editor.projectsites.dev', 'http://localhost:5173'];

// PS_DATA_REQUEST browse-filter operators — mirrors the worker's FILTER_OPS. We only forward an op
// the worker recognizes (it defaults anything else to `eq`); null/notnull carry no value.
const PS_FILTER_OPS = new Set([
  'eq',
  'ne',
  'contains',
  'startswith',
  'endswith',
  'gt',
  'lt',
  'gte',
  'lte',
  'null',
  'notnull',
]);
const PS_FILTER_VALUE_FREE_OPS = new Set(['null', 'notnull']);

export interface BoltEmbedSite {
  readonly id: string;
  readonly slug: string;
  readonly business_name?: string;
  /** Site lifecycle status. NOT sufficient alone to gate chat import — see `current_build_version`. */
  readonly status?: string;
  /**
   * The R2 build version. This — NOT `status==='published'` — is the true
   * "has an `_manifest.json` in R2" signal: a published-but-unbuilt site
   * (`published` + null build) has NO manifest, so importing its chat would 404.
   */
  readonly current_build_version?: string | number | null;
}

interface PsMessage {
  readonly type?: string;
  readonly status?: string;
  readonly error?: string;
  readonly message?: string;
  readonly files?: Record<string, string> | { path: string; size: number }[];
  readonly chat?: { messages: unknown[]; description?: string; exportDate?: string };
  readonly correlationId?: string;
  readonly kind?: 'info' | 'success' | 'warning' | 'error';
  readonly level?: 'info' | 'success' | 'warning' | 'error';
  /** PS_DATA_REQUEST (AL-004): omit for the table overview, set to browse one table. */
  readonly table?: string;
  /** PS_DATA_REQUEST: 0-based row offset for the paginated browse grid (default 0). */
  readonly offset?: number;
  /** PS_DATA_REQUEST: page size for the paginated browse grid (worker clamps to 1–100; default 25). */
  readonly limit?: number;
  /** PS_DATA_REQUEST: server-side sort column (worker allowlist-validates it; else default sort). */
  readonly orderBy?: string;
  /** PS_DATA_REQUEST: server-side sort direction for `orderBy` (worker clamps to asc/desc). */
  readonly dir?: string;
  /** PS_DATA_REQUEST: multi-column sort `col:dir,…` (worker allowlist-validates each; precedes orderBy/dir). */
  readonly sort?: string;
  /** PS_DATA_REQUEST: whole-table search (worker: OR-of-LIKE over allowlisted columns; affects `total`). */
  readonly search?: string;
  /** PS_DATA_REQUEST: exact-match filter column (worker allowlist-validates it; else no filter). */
  readonly filterCol?: string;
  /** PS_DATA_REQUEST: value for `filterCol` (worker parameterizes it; ignored for null/notnull ops). */
  readonly filterVal?: string;
  /**
   * PS_DATA_REQUEST: comparison operator for `filterCol`
   * (eq|ne|contains|gt|lt|gte|lte|null|notnull). The worker maps it to a FIXED clause — never
   * user text — and defaults an absent/unknown op to `eq`. null/notnull are value-free.
   */
  readonly filterOp?: string;
  /**
   * PS_DATA_REQUEST: a multi-condition filter group as a JSON array of `{col,op,val}` (the worker
   * shape-hardens + re-validates every leaf against the table allowlist, bounds the count, and joins by
   * {@link filterCombinator}). When present it takes precedence over the single `filterCol/Op/Val`.
   */
  readonly filters?: string;
  /** PS_DATA_REQUEST: how to join the {@link filters} conditions — `AND` | `OR` (worker default `AND`). */
  readonly filterCombinator?: string;
  /** PS_DATA_REQUEST: 0 = skip the COUNT(*) (paging/sorting → reuse cached total); else the worker counts. */
  readonly count?: number;
  /** PS_DATA_REQUEST: export the WHOLE current query (routes to /data-overview/:table/export). */
  readonly exportAll?: boolean;
  /** PS_DATA_REQUEST: kanban whole-query lane counts — routes to /data-overview/:table/group-counts. */
  readonly groupBy?: string;
  /** PS_DATA_REQUEST (chart aggregate): numeric measure column + agg fn (sum|avg|min|max) alongside groupBy. */
  readonly measure?: string;
  readonly agg?: string;
  /** PS_DATA_REQUEST (footer summaries): comma-list of columns → routes to /data-overview/:table/column-aggregates. */
  readonly columnsAgg?: string;
  /** PS_DATA_REQUEST (value datalist): one column → routes to /data-overview/:table/column-distinct. */
  readonly columnDistinct?: string;
  /** PS_VIEW_REQUEST (saved grid views): `list` | `save` | `delete`. */
  readonly action?: string;
  /** PS_VIEW_REQUEST delete: the view id. */
  readonly viewId?: string;
  /** PS_VIEW_REQUEST save: the render type — `grid` | `gallery`. */
  readonly viewType?: string;
  /**
   * PS_VIEW_REQUEST save: view display config — card-title/group/date fields + the full column `layout`
   * (visibility/order/widths/pins/summaries/density). Forwarded opaquely to the worker, which shape-hardens.
   */
  readonly viewConfig?: {
    titleField?: string;
    groupField?: string;
    dateField?: string;
    sorts?: string;
    layout?: {
      hidden?: string[];
      order?: string[];
      widths?: Record<string, number>;
      pinned?: string[];
      summaries?: Record<string, string>;
      density?: string;
    };
  };
  /** PS_VIEW_REQUEST save: how to join the filter group — `AND` | `OR`. */
  readonly combinator?: string;
  /** PS_VIEW_REQUEST save: the single-column sort (worker re-normalizes). */
  readonly sortCol?: string | null;
  readonly sortDir?: string | null;
  /** PS_SQL_REQUEST (D1 manager): the SQL to forward — /sql/exec (read) or /sql/exec-write (write). */
  readonly query?: string;
  /** PS_SQL_REQUEST: route to the WRITE endpoint (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE). */
  readonly write?: boolean;
  /** PS_SQL_REQUEST: confirm a destructive write (DROP/ALTER, or unscoped DELETE/UPDATE). */
  readonly confirm?: boolean;
  /**
   * PS_SQL_REQUEST: positional bind params for ?1, ?2, … The worker BINDS these (never
   * concatenates), so the grid's typed row editors (Add/Edit/Delete) can build a parameterized
   * statement instead of stringifying user values into SQL.
   */
  readonly params?: Array<string | number | boolean | null>;
  /** PS_NL2SQL_REQUEST (AI SQL assistant): the natural-language question to translate to SQL. */
  readonly question?: string;
  /** PS_KV_REQUEST (KV inspector): which read op to proxy to /api/admin/kv/*. */
  readonly op?:
    | 'namespaces'
    | 'keys'
    | 'value'
    | 'buckets'
    | 'objects'
    | 'object'
    | 'indexes'
    | 'index'
    | 'queues'
    | 'queue'
    | 'databases'
    | 'overview'
    | 'tables'
    | 'export'
    | 'explain'
    | 'profile'
    | 'insights'
    | 'put'
    | 'delete';
  /** PS_R2_REQUEST: the R2 bucket binding name (required for the objects + object ops). */
  readonly bucket?: string;
  /** PS_VEC_REQUEST: the Vectorize index name (required for the `index` describe op). */
  readonly name?: string;
  /** PS_QUEUE_REQUEST: the queue id (required for the `queue` describe op). */
  readonly queueId?: string;
  /** PS_D1_REQUEST: the D1 database UUID (required for the `overview` / `tables` / `columns` / `export` ops). */
  readonly databaseId?: string;
  /** PS_D1_REQUEST (export op): scope the SQL dump to specific tables. */
  readonly tables?: string[];
  /** PS_D1_REQUEST (export op): schema-only / data-only dump. */
  readonly schemaOnly?: boolean;
  readonly dataOnly?: boolean;
  /** PS_D1_REQUEST (export op): resume an in-progress export via a prior `bookmark`. */
  readonly currentBookmark?: string;
  /** PS_KV_REQUEST: the KV binding name (required for the keys + value ops). */
  readonly binding?: string;
  /** PS_KV_REQUEST (keys op): key-name prefix filter. */
  readonly prefix?: string;
  /** PS_KV_REQUEST (keys op): opaque pagination cursor from the previous page. */
  readonly cursor?: string;
  /** PS_KV_REQUEST (value / put / delete ops): the exact key. */
  readonly key?: string;
  /** PS_KV_REQUEST (put op): the value to write. */
  readonly value?: string;
  /** PS_KV_REQUEST (put op): optional expiry in seconds (KV minimum 60). */
  readonly expirationTtl?: number;
  /** PS_KV_REQUEST (put op): explicitly remove the expiration (make the key permanent). */
  readonly clearExpiration?: boolean;
}

export interface BoltFileEntry {
  readonly path: string;
  readonly size: number;
}

/** Options accepted by `bootForSite` — `file` + `line` deep-link the editor. */
export interface BootOptions {
  readonly file?: string;
  readonly line?: number;
}

@Injectable({ providedIn: 'root' })
export class BoltEmbedService {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** Sanitized iframe URL — null until a site has been selected. */
  readonly iframeUrl = signal<SafeResourceUrl | null>(null);
  /** True once the iframe has fired PS_APP_RUNNING (or a timeout fallback). */
  readonly editorReady = signal(false);
  /** Human label for the loading veil. */
  readonly loadingStage = signal('Booting the AI editor');
  /**
   * Boot phase 0-4 for the loading veil's progress stepper. Advances monotonically through
   * a SINGLE continuous veil (0 boot → 1 workspace → 2 preparing → 3/4 ready) — it never
   * flips backward, so the indicator shows ONCE and fills, never flickers.
   */
  readonly loadingPhase = signal(0);
  /** True while a save-and-deploy round-trip is in flight. */
  readonly saving = signal(false);

  /** The actual `<iframe>` element — registered by `AdminComponent` once it mounts. */
  private iframeEl: HTMLIFrameElement | null = null;
  private currentSlug: string | null = null;
  private currentSite: BoltEmbedSite | null = null;
  /**
   * Whether the signed-in admin is a platform super-admin — pushed by AdminComponent from
   * `AdminStateService.isSuperAdmin()` (hydrated from /api/auth/me). Gates the editor's D1-manager
   * SQL console: the `/sql/exec` endpoint reads the shared multi-tenant DB and is super-admin-only
   * (AL-792), so we tell the editor `canRunSql` up-front rather than let it render a doomed console.
   */
  readonly superAdmin = signal(false);
  private boltReady = false;
  private hardTimeout: ReturnType<typeof setTimeout> | null = null;
  private softTimeout: ReturnType<typeof setTimeout> | null = null;
  private messageHandler: ((e: MessageEvent) => void) | null = null;
  /** In-flight `PS_LIST_FILES` requests keyed by correlationId (item 45). */
  private readonly pendingFileLists = new Map<string, (files: BoltFileEntry[]) => void>();
  /** correlationIds of `PS_FILES_READY` replies already published — the editor
   *  answers a `PS_REQUEST_FILES` from BOTH the route-scoped chat handler AND
   *  the module-level responder (same correlationId), so without dedupe every
   *  Save & Deploy double-published (journey 2026-08-19). */
  private readonly publishedCorrelationIds = new Set<string>();
  /** Optional consumer for `PS_DEPLOY_REQUEST` messages from the editor (item 43). */
  private deployHandler:
    | ((req: {
        files: Record<string, string>;
        chat?: { messages: unknown[]; description?: string; exportDate?: string };
      }) => void)
    | null = null;
  /** Toast ids already mirrored to the editor — prevents echo loops (item 44). */
  private readonly mirroredToastIds = new Set<number>();
  /** True while we're showing a toast forwarded FROM the editor — stops
   *  the mirror effect from bouncing it right back as a `PS_TOAST`. */
  private suppressMirror = false;

  constructor() {
    /*
     * Item 44 — mirror admin toasts into the editor as `PS_TOAST` messages.
     * No-op while the iframe isn't booted; once the user opens /admin/editor
     * every fresh toast surfaces in both shells without writing code at the
     * call site. We track mirrored ids in a Set so the same toast isn't
     * forwarded twice as the signal re-emits.
     */
    effect(() => {
      const toasts = this.toast.toasts();
      if (!this.iframeEl?.contentWindow || this.suppressMirror) return;
      for (const t of toasts) {
        if (this.mirroredToastIds.has(t.id)) continue;
        this.mirroredToastIds.add(t.id);
        // Cap memory — keep only the last 200 ids.
        if (this.mirroredToastIds.size > 200) {
          const first = this.mirroredToastIds.values().next().value;
          if (first !== undefined) this.mirroredToastIds.delete(first);
        }
        this.forwardToast(t.type, t.message);
      }
    });
  }
  /** Hidden pre-warm iframe element. Removed once the real iframe takes over. */
  private prewarmEl: HTMLIFrameElement | null = null;
  /** Has the page-level pre-warm (modulepreload + hidden iframe) already fired? */
  private hasPrewarmed = false;

  /**
   * Item 1 (perf): Spin up a hidden, off-screen iframe pointed at the bolt.diy
   * editor as soon as the user lands on `/admin` — before any site is even
   * selected. By the time the user clicks Editor, the editor bundle +
   * WebContainer cold boot have already been paid in the hidden tab and the
   * eventual `bootForSite()` call gets warm caches.
   *
   * Also injects `<link rel="modulepreload">` for the editor's main entry +
   * `<link rel="prefetch">` for the document so the browser races the TCP +
   * TLS handshake to `editor.projectsites.dev` while the Angular shell paints.
   *
   * Idempotent — safe to call from a route guard, an effect, or a hover
   * handler on the Editor nav button.
   */
  prewarmEditor(): void {
    if (this.hasPrewarmed || typeof document === 'undefined') return;
    this.hasPrewarmed = true;
    try {
      // Prefetch the document HTML so the iframe load on real click is warm.
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'document';
      link.href = `${EDITOR_BASE}/?embedded=true&prewarm=true`;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);

      // Hidden iframe mounted off-screen — fires the real GET so the bolt
      // bundle + WebContainer download starts in parallel with admin paint.
      // We intentionally do NOT attach a message listener — this iframe is
      // throwaway, the real iframe (registered via registerIframe) will pick
      // up its own postMessage protocol when bootForSite() runs.
      const frame = document.createElement('iframe');
      frame.src = `${EDITOR_BASE}/?embedded=true&prewarm=true`;
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
      // `loading=eager` is the default but we make it explicit — pre-warm is
      // the whole point, lazy would defeat the purpose.
      frame.loading = 'eager';
      document.body.appendChild(frame);
      this.prewarmEl = frame;

      // Clean up the throwaway iframe after 90s — by then the real iframe has
      // taken over or the user has left the admin shell entirely.
      setTimeout(() => this.disposePrewarm(), 90_000);
    } catch (err) {
      // Pre-warm is a perf hint — never let it bubble up as a user-facing
      // error. Structured logs capture the cause if we ever care.
      console.warn('[bolt-embed] prewarmEditor failed', err);
      this.hasPrewarmed = false;
    }
  }

  private disposePrewarm(): void {
    if (this.prewarmEl?.parentNode) {
      this.prewarmEl.parentNode.removeChild(this.prewarmEl);
    }
    this.prewarmEl = null;
  }

  /**
   * Called once by `AdminComponent` after its `<iframe #boltFrame>` view child
   * is available. Lets the service read response data + dispatch messages.
   */
  registerIframe(el: HTMLIFrameElement | null): void {
    this.iframeEl = el;
  }

  /**
   * Boot (or rebind) the iframe for a given site. Idempotent — re-calling
   * with the same slug is a no-op so the iframe never reloads when the user
   * switches between admin sub-routes for the same site.
   *
   * @param site - the site to bind, or `null` to tear the iframe down.
   * @param opts - optional `file` + `line` deep-link (item 42). When present
   *   on the same-slug fast-path we forward via `PS_OPEN_FILE` instead of
   *   reloading the iframe.
   */
  bootForSite(site: BoltEmbedSite | null, opts: BootOptions = {}): void {
    if (!site) {
      this.teardown();
      return;
    }
    if (this.currentSlug === site.slug) {
      this.currentSite = site;
      if (opts.file) this.openFile(opts.file, opts.line);
      return;
    }
    // The hidden pre-warm iframe (if any) has done its job — the real iframe
    // will own the editor lifecycle from here. Dispose to free a doc + memory.
    this.disposePrewarm();
    this.currentSite = site;
    this.currentSlug = site.slug;
    this.editorReady.set(false);
    this.boltReady = false;
    this.loadingPhase.set(0);
    this.loadingStage.set('Booting the AI editor');

    const params = new URLSearchParams({
      embedded: 'true',
      hideHeader: 'true',
      hideDiff: 'true',
      hideDeploy: 'true',
      slug: site.slug,
    });
    // Import prior chat/files for any site that actually HAS built content in R2.
    // The gate is `current_build_version` ALONE — it is the real `_manifest.json`
    // indicator. We deliberately do NOT also require `status==='published'`: a
    // site that has a build but whose status has drifted (e.g. back to `draft`
    // after an inline edit, or mid-`generating`) still has a manifest to import,
    // and requiring `published` too silently stranded the editor with ZERO files
    // for such sites (Brian, 2026-08-20). A published-but-UNBUILT site has null
    // `current_build_version`, so it still correctly starts a fresh chat instead
    // of firing a guaranteed-404 `/api/sites/by-slug/:slug/chat` import.
    if (site.current_build_version) {
      params.set('importChatFrom', `${window.location.origin}/api/sites/by-slug/${site.slug}/chat`);
    }
    if (opts.file) params.set('file', opts.file);
    if (opts.line && Number.isFinite(opts.line) && opts.line > 0)
      params.set('line', String(opts.line));
    this.iframeUrl.set(
      this.sanitizer.bypassSecurityTrustResourceUrl(`${EDITOR_BASE}/?${params.toString()}`),
    );

    this.attachMessageListener();
    this.clearTimers();
    this.hardTimeout = setTimeout(() => this.dismissVeil('timeout'), HARD_TIMEOUT_MS);
  }

  /**
   * Item 41 — rebase the editor's WebContainer to a snapshot. Fired by row
   * clicks in `AdminSnapshotsComponent`. The iframe re-imports the
   * snapshot's chat-export via the existing `by-slug/chat` endpoint.
   */
  openSnapshot(snapshotId: string): void {
    const iframe = this.iframeEl;
    const site = this.currentSite;
    if (!iframe?.contentWindow || !site) {
      this.toast.warning('Editor not ready — open the Editor tab first');
      return;
    }
    iframe.contentWindow.postMessage(
      {
        type: 'PS_OPEN_SNAPSHOT',
        snapshot_id: snapshotId,
        slug: site.slug,
        correlationId: crypto.randomUUID(),
      },
      EDITOR_BASE,
    );
  }

  /**
   * Item 42 — jump to a file (and optional 1-based line) in CodeMirror.
   * Sends `PS_OPEN_FILE`; the editor resolves the path against its
   * workbench and scrolls the editor pane.
   */
  openFile(file: string, line?: number): void {
    const iframe = this.iframeEl;
    if (!iframe?.contentWindow) {
      this.toast.warning('Editor not ready — open the Editor tab first');
      return;
    }
    iframe.contentWindow.postMessage(
      { type: 'PS_OPEN_FILE', file, line, correlationId: crypto.randomUUID() },
      EDITOR_BASE,
    );
  }

  /**
   * Item 45 — enumerate every text file currently in the editor's
   * workbench. Resolves with `{ path, size }[]`, or rejects on timeout.
   * Multiple concurrent calls are safe — each gets its own `correlationId`.
   */
  listFiles(timeoutMs = 4000): Promise<BoltFileEntry[]> {
    const iframe = this.iframeEl;
    if (!iframe?.contentWindow) {
      return Promise.reject(new Error('Editor not ready'));
    }
    const correlationId = crypto.randomUUID();
    return new Promise<BoltFileEntry[]>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingFileLists.delete(correlationId);
        reject(new Error('Timed out waiting for editor file list'));
      }, timeoutMs);
      this.pendingFileLists.set(correlationId, (files: BoltFileEntry[]) => {
        window.clearTimeout(timer);
        resolve(files);
      });
      iframe.contentWindow!.postMessage({ type: 'PS_LIST_FILES', correlationId }, EDITOR_BASE);
    });
  }

  /**
   * Item 44 — forward an admin-side toast into the editor so the user sees
   * the same message whether their eyes are on the editor pane or the
   * admin chrome. No-op when the iframe is not booted.
   */
  forwardToast(kind: 'info' | 'success' | 'warning' | 'error', message: string): void {
    const iframe = this.iframeEl;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: 'PS_TOAST', kind, message, correlationId: crypto.randomUUID() },
      EDITOR_BASE,
    );
  }

  /**
   * Send the iframe a `PS_REQUEST_FILES` message and wait for `PS_FILES_READY`
   * to upload and deploy. Returns nothing — caller listens to {@link saving}.
   */
  saveAndDeploy(): void {
    const site = this.currentSite;
    const iframe = this.iframeEl;
    if (!iframe?.contentWindow || !site) {
      this.toast.error('Editor not ready');
      return;
    }
    this.saving.set(true);
    iframe.contentWindow.postMessage(
      { type: 'PS_REQUEST_FILES', includeChat: true, correlationId: crypto.randomUUID() },
      '*',
    );
    this.toast.info('Saving files from editor...');
    setTimeout(() => {
      if (this.saving()) {
        this.saving.set(false);
        this.toast.error('Save timed out. The editor may not have responded.');
      }
    }, SAVE_TIMEOUT_MS);
  }

  /**
   * Open the editor in a new tab with the same site context, full-screen.
   * Used by the "Open in new tab" affordance on the editor route.
   */
  openFullscreen(): void {
    if (!this.currentSlug) return;
    window.open(`${EDITOR_BASE}/?slug=${this.currentSlug}`, '_blank', 'noopener,noreferrer');
  }

  /** Tear down everything — called when the user signs out or unselects sites. */
  teardown(): void {
    this.detachMessageListener();
    this.clearTimers();
    this.disposePrewarm();
    this.iframeUrl.set(null);
    this.editorReady.set(false);
    this.currentSlug = null;
    this.currentSite = null;
    this.boltReady = false;
    this.hasPrewarmed = false;
    this.pendingFileLists.clear();
  }

  // ── internals ──────────────────────────────────────────────────

  private dismissVeil(_reason: 'app_running' | 'timeout' | 'chat_grace' | 'files_loaded'): void {
    if (this.editorReady()) return;
    this.loadingPhase.set(4);
    this.editorReady.set(true);
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.hardTimeout) {
      clearTimeout(this.hardTimeout);
      this.hardTimeout = null;
    }
    if (this.softTimeout) {
      clearTimeout(this.softTimeout);
      this.softTimeout = null;
    }
  }

  private attachMessageListener(): void {
    if (this.messageHandler) return;
    this.messageHandler = (event: MessageEvent): void => {
      if (!ALLOWED_ORIGINS.includes(event.origin)) return;
      const msg = event.data as PsMessage | null;
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('PS_')) return;

      switch (msg.type) {
        case 'PS_BOLT_READY':
          // bolt.diy's shell is up, but the WebContainer is still cold-booting behind it.
          // Do NOT dismiss here — keeping ONE veil over the WHOLE boot is the whole point.
          // A premature dismiss reveals bolt's own boot UI underneath → the exact
          // show→hide→show→hide flicker we're killing. Just advance the phase.
          this.boltReady = true;
          this.loadingPhase.set(1);
          this.loadingStage.set('Starting the workspace');
          break;
        case 'PS_APP_RUNNING':
          // The preview app is actually running — the TRUE ready signal. Dismiss now.
          this.dismissVeil('app_running');
          break;
        case 'PS_BOLT_CHAT_READY':
          // The chat placeholder has painted (interactive) but the preview is usually still
          // installing/booting. Advance the phase and arm a short GRACE fallback so we never
          // hang if no preview-ready arrives — in the common case PS_BOLT_FILES_LOADED /
          // PS_APP_RUNNING fires first and dismisses cleanly before the grace elapses.
          this.loadingPhase.set(2);
          this.loadingStage.set('Preparing your site');
          if (!this.softTimeout) {
            this.softTimeout = setTimeout(() => this.dismissVeil('chat_grace'), CHAT_GRACE_MS);
          }
          break;
        case 'PS_BOLT_FILES_LOADED':
          // Every project file is now in the editor — the in-iframe loader fades on
          // this exact signal, so the parent veil dismisses on it too. This is the
          // ACCURATE "editor is usable" moment (code + file tree populated), replacing
          // the blind CHAT_GRACE guess: reveal the editor the instant files are in
          // rather than after a fixed 10s, and in perfect sync with the loader beneath
          // (both fade together → no flicker). The preview keeps booting behind it.
          this.loadingPhase.set(3);
          this.loadingStage.set('Loading your files');
          this.dismissVeil('files_loaded');
          break;
        case 'PS_FILES_READY': {
          // Dedupe: the editor replies once per registered responder — the
          // route-scoped chat handler AND the module-level responder both
          // answer the SAME correlationId. Publish once per save; a second
          // identical reply is a no-op (distinct saves carry distinct ids).
          if (msg.correlationId) {
            if (this.publishedCorrelationIds.has(msg.correlationId)) {
              break;
            }
            this.publishedCorrelationIds.add(msg.correlationId);
          }
          this.uploadFiles((msg.files as Record<string, string> | undefined) ?? {}, msg.chat);
          break;
        }
        case 'PS_GENERATION_STATUS':
          if (msg.status === 'complete') {
            this.toast.success('AI generation complete');
            this.saveAndDeploy();
          } else if (msg.status === 'app_ready' || msg.status === 'preview_ready') {
            this.dismissVeil('app_running');
          } else if (msg.status === 'error') {
            this.toast.error('AI generation failed: ' + (msg.error || 'Unknown error'));
          }
          break;
        case 'PS_ERROR':
          this.toast.error('Editor error: ' + (msg.message || 'Unknown error'));
          this.saving.set(false);
          break;
        case 'PS_FILES_LIST': {
          // Item 45 — fulfil the matching pending `listFiles()` promise.
          const cid = msg.correlationId;
          if (!cid) break;
          const resolver = this.pendingFileLists.get(cid);
          if (resolver) {
            this.pendingFileLists.delete(cid);
            resolver(Array.isArray(msg.files) ? (msg.files as BoltFileEntry[]) : []);
          }
          break;
        }
        case 'PS_DEPLOY_REQUEST': {
          // Item 43 — editor asked us to run the deploy. If a consumer has
          // registered a handler, hand off; else fall back to the standard
          // publish-bolt flow used by `saveAndDeploy()`.
          const files = (msg.files as Record<string, string> | undefined) ?? {};
          if (this.deployHandler) {
            this.deployHandler({ files, chat: msg.chat });
          } else {
            this.saving.set(true);
            this.uploadFiles(files, msg.chat);
          }
          break;
        }
        case 'PS_DATA_REQUEST': {
          // AL-004 Data tab — the embedded editor has no cross-origin session,
          // so it asks US (we hold currentSite + the ApiService bearer) to read
          // the site's real data via /api/sites/:id/data-overview[/:table]. Reply
          // with PS_DATA_RESPONSE. Mirrors the PS_DEPLOY_REQUEST bridge pattern.
          const iframe = this.iframeEl;
          const site = this.currentSite;
          const cid = msg.correlationId;
          const table = typeof msg.table === 'string' && msg.table ? msg.table : undefined;
          // Pagination — forwarded to the worker (which clamps limit 1–100, offset ≥ 0). Defaults
          // preserve the prior behaviour (first page of 25) when the editor omits them.
          const browseLimit =
            typeof msg.limit === 'number' && Number.isFinite(msg.limit)
              ? Math.max(1, Math.min(100, Math.trunc(msg.limit)))
              : 25;
          const browseOffset =
            typeof msg.offset === 'number' && Number.isFinite(msg.offset)
              ? Math.max(0, Math.trunc(msg.offset))
              : 0;
          // Server-side sort — forwarded when present; the WORKER allowlist-validates orderBy against
          // the table's columns (and clamps dir to asc/desc), so an unknown column is safely ignored.
          const browseOrderBy =
            typeof msg.orderBy === 'string' && msg.orderBy ? msg.orderBy.slice(0, 64) : undefined;
          const browseDir = msg.dir === 'asc' ? 'asc' : msg.dir === 'desc' ? 'desc' : undefined;
          // Multi-column sort `col:dir,…` — forwarded as-is; the worker allowlist-validates + bounds each key.
          const browseSort =
            typeof msg.sort === 'string' && msg.sort.trim()
              ? msg.sort.trim().slice(0, 256)
              : undefined;
          // Whole-table search — the WORKER runs the OR-of-LIKE over allowlisted columns (parameterized)
          // and reflects it in `total`; we just forward the trimmed, length-capped needle.
          const browseSearch =
            typeof msg.search === 'string' && msg.search.trim()
              ? msg.search.trim().slice(0, 128)
              : undefined;
          // Exact-column filter — the WORKER allowlist-validates filterCol against the table's columns
          // and parameterizes filterVal; we forward the trimmed, length-capped pair only when both set.
          const browseFilterCol =
            typeof msg.filterCol === 'string' && msg.filterCol.trim()
              ? msg.filterCol.trim().slice(0, 64)
              : undefined;
          const browseFilterVal =
            typeof msg.filterVal === 'string' && msg.filterVal.trim()
              ? msg.filterVal.trim().slice(0, 200)
              : undefined;
          // Comparison operator (eq|ne|contains|gt|lt|gte|lte|null|notnull) — forward only a
          // worker-recognized op (else the worker defaults to eq anyway). null/notnull are value-free,
          // so they filter on the column ALONE (no filterVal required).
          const browseFilterOp =
            typeof msg.filterOp === 'string' && PS_FILTER_OPS.has(msg.filterOp.trim().toLowerCase())
              ? msg.filterOp.trim().toLowerCase()
              : undefined;
          const browseFilterValueFree = browseFilterOp
            ? PS_FILTER_VALUE_FREE_OPS.has(browseFilterOp)
            : false;
          // Multi-condition filter group — a JSON array of {col,op,val}. Forwarded (taking precedence
          // over the single-column filter below) when it parses to a NON-EMPTY array within a sane size;
          // the WORKER re-validates every leaf against the table allowlist, bounds the count, and joins
          // by filterCombinator. Admin does a cheap sanity check only — the worker is the authority.
          let browseFilters: string | undefined;
          if (typeof msg.filters === 'string' && msg.filters.length <= 4000) {
            try {
              const parsed: unknown = JSON.parse(msg.filters);
              if (Array.isArray(parsed) && parsed.length > 0) {
                browseFilters = msg.filters;
              }
            } catch {
              browseFilters = undefined;
            }
          }
          const browseFilterCombinator =
            typeof msg.filterCombinator === 'string' &&
            ['and', 'or'].includes(msg.filterCombinator.trim().toLowerCase())
              ? msg.filterCombinator.trim().toUpperCase()
              : undefined;
          // count=0 → the editor is paging/sorting and reuses its cached total; forward the skip so the
          // worker doesn't run an expensive COUNT(*) on every nav. Any other value → the worker counts.
          const browseSkipCount = msg.count === 0;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_DATA_RESPONSE', correlationId: cid, table, ...payload },
              EDITOR_BASE,
            );
          };
          if (!site) {
            reply({ error: 'No site selected' });
            break;
          }
          // Three routing modes off /data-overview/:table: whole-query EXPORT (/export, all rows),
          // kanban GROUP-COUNTS (/group-counts, whole-query lane totals), or the paginated browse.
          // Export + group-counts drop pagination/count; all three share the sort/search/filter params.
          const isExport = msg.exportAll === true && !!table;
          const browseGroupBy =
            typeof msg.groupBy === 'string' && msg.groupBy.trim()
              ? msg.groupBy.trim().slice(0, 64)
              : undefined;
          const isGroupCounts = !!browseGroupBy && !!table && !isExport;
          // Chart aggregate (optional, paired): a numeric measure column + agg fn. Forwarded to
          // /group-counts only when BOTH are present; the worker re-validates + falls back to COUNT.
          const browseMeasure =
            typeof msg.measure === 'string' && msg.measure.trim()
              ? msg.measure.trim().slice(0, 64)
              : undefined;
          const browseAgg =
            typeof msg.agg === 'string' && msg.agg.trim()
              ? msg.agg.trim().slice(0, 8).toLowerCase()
              : undefined;
          // Whole-query column summaries (grid footer): a comma-list of columns → /column-aggregates.
          const browseColumnsAgg =
            typeof msg.columnsAgg === 'string' && msg.columnsAgg.trim()
              ? msg.columnsAgg.trim().slice(0, 2000)
              : undefined;
          const isColumnAgg = !!browseColumnsAgg && !!table && !isExport && !isGroupCounts;
          // Value datalist (cell editor): one column → /column-distinct (bounded DISTINCT suggestions).
          const browseColumnDistinct =
            typeof msg.columnDistinct === 'string' && msg.columnDistinct.trim()
              ? msg.columnDistinct.trim().slice(0, 64)
              : undefined;
          const isColumnDistinct =
            !!browseColumnDistinct && !!table && !isExport && !isGroupCounts && !isColumnAgg;
          // The search + filter query params (shared by all three modes).
          const filterParams: Record<string, string> = {
            ...(browseSearch ? { search: browseSearch } : {}),
            ...(browseFilters
              ? {
                  filters: browseFilters,
                  ...(browseFilterCombinator ? { filterCombinator: browseFilterCombinator } : {}),
                }
              : browseFilterCol && (browseFilterValueFree || browseFilterVal)
                ? {
                    filterCol: browseFilterCol,
                    ...(browseFilterOp ? { filterOp: browseFilterOp } : {}),
                    ...(browseFilterValueFree ? {} : { filterVal: browseFilterVal as string }),
                  }
                : {}),
          };
          const suffix = isExport
            ? '/export'
            : isGroupCounts
              ? '/group-counts'
              : isColumnAgg
                ? '/column-aggregates'
                : isColumnDistinct
                  ? '/column-distinct'
                  : '';
          const path = table
            ? `/sites/${site.id}/data-overview/${encodeURIComponent(table)}${suffix}`
            : `/sites/${site.id}/data-overview`;
          this.api
            .get<{ data?: unknown; total?: number }>(
              path,
              table
                ? isGroupCounts
                  ? {
                      groupBy: browseGroupBy as string,
                      ...(browseMeasure && browseAgg
                        ? { measure: browseMeasure, agg: browseAgg }
                        : {}),
                      ...filterParams,
                    }
                  : isColumnAgg
                    ? { columns: browseColumnsAgg as string, ...filterParams }
                    : isColumnDistinct
                      ? { column: browseColumnDistinct as string }
                      : {
                          ...(isExport
                            ? {}
                            : { limit: String(browseLimit), offset: String(browseOffset) }),
                          ...(browseSort ? { sort: browseSort } : {}),
                          ...(browseOrderBy ? { orderBy: browseOrderBy } : {}),
                          ...(browseOrderBy && browseDir ? { dir: browseDir } : {}),
                          ...filterParams,
                          ...(browseSkipCount && !isExport ? { count: '0' } : {}),
                        }
                : undefined,
              { silent: true },
            )
            .subscribe({
              // Tell the editor whether the D1-manager SQL console is available (super-admin only) —
              // merged into the OVERVIEW reply so it never renders a console that would only 403.
              // For a browse, forward the worker's `total` (reflects the search filter) so the grid
              // can page through the MATCHES + show an honest match count.
              next: (res) => {
                const data = (res?.data ?? null) as Record<string, unknown> | null;
                reply({
                  data: data && !table ? { ...data, canRunSql: this.superAdmin() } : data,
                  ...(table && typeof res?.total === 'number' ? { total: res.total } : {}),
                });
              },
              error: () => reply({ error: 'Failed to load data' }),
            });
          break;
        }
        case 'PS_VIEW_REQUEST': {
          // Saved grid views (Data tab) — the editor has no cross-origin session, so we proxy to the
          // org-gated /api/sites/:id/grid-views endpoints (list/save/delete) and reply PS_VIEW_RESPONSE.
          // The WORKER re-validates ownership + every filter leaf; we just forward the current session.
          const iframe = this.iframeEl;
          const site = this.currentSite;
          const cid = msg.correlationId;
          const action = msg.action;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_VIEW_RESPONSE', correlationId: cid, action, ...payload },
              EDITOR_BASE,
            );
          };
          if (!site) {
            reply({ error: 'No site selected' });
            break;
          }
          const viewTable = typeof msg.table === 'string' ? msg.table.trim().slice(0, 64) : '';
          const base = `/sites/${site.id}/grid-views`;
          if (action === 'list') {
            this.api
              .get<{ data?: { views?: unknown[] } }>(
                base,
                viewTable ? { table: viewTable } : undefined,
                {
                  silent: true,
                },
              )
              .subscribe({
                next: (res) => reply({ views: res?.data?.views ?? [] }),
                error: () => reply({ error: 'Failed to load views' }),
              });
          } else if (action === 'save') {
            if (!viewTable || typeof msg.name !== 'string' || !msg.name.trim()) {
              reply({ error: 'A view name and table are required' });
              break;
            }
            this.api
              .post<{ data?: { view?: unknown } }>(
                base,
                {
                  table: viewTable,
                  name: msg.name.trim().slice(0, 80),
                  filters: typeof msg.filters === 'string' ? msg.filters : '[]',
                  combinator: msg.combinator ?? 'AND',
                  sortCol: msg.sortCol ?? null,
                  sortDir: msg.sortDir ?? null,
                  search: msg.search ?? '',
                  type: msg.viewType ?? 'grid',
                  config: msg.viewConfig ?? {},
                },
                { silent: true },
              )
              .subscribe({
                next: (res) => reply({ view: res?.data?.view ?? null }),
                error: () => reply({ error: 'Failed to save view' }),
              });
          } else if (action === 'update') {
            if (!msg.viewId || typeof msg.name !== 'string' || !msg.name.trim()) {
              reply({ error: 'A view id and name are required' });
              break;
            }
            this.api
              .put<{ data?: { view?: unknown } }>(
                `${base}/${encodeURIComponent(msg.viewId)}`,
                {
                  name: msg.name.trim().slice(0, 80),
                  filters: typeof msg.filters === 'string' ? msg.filters : '[]',
                  combinator: msg.combinator ?? 'AND',
                  sortCol: msg.sortCol ?? null,
                  sortDir: msg.sortDir ?? null,
                  search: msg.search ?? '',
                  type: msg.viewType ?? 'grid',
                  config: msg.viewConfig ?? {},
                },
                { silent: true },
              )
              .subscribe({
                next: (res) => reply({ view: res?.data?.view ?? null }),
                error: () => reply({ error: 'Failed to update view' }),
              });
          } else if (action === 'delete') {
            if (!msg.viewId) {
              reply({ error: 'No view id' });
              break;
            }
            this.api
              .delete<unknown>(`${base}/${encodeURIComponent(msg.viewId)}`, { silent: true })
              .subscribe({
                next: () => reply({ deleted: true }),
                error: () => reply({ error: 'Failed to delete view' }),
              });
          } else {
            reply({ error: 'Unknown view action' });
          }
          break;
        }
        case 'PS_QUEUE_REQUEST': {
          // Queues inspector — mirrors the PS_VEC bridge. Proxies read-only queue inspection to
          // /api/admin/queues/* (super-admin; list + describe only, never send/purge/ack).
          const iframe = this.iframeEl;
          const cid = msg.correlationId;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_QUEUE_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          const op = msg.op;
          let qPath: string;
          if (op === 'queues') {
            qPath = '/admin/queues';
          } else if (op === 'queue') {
            if (!msg.queueId) {
              reply({ ok: false, error: 'No queue id' });
              break;
            }
            qPath = `/admin/queues/${encodeURIComponent(msg.queueId)}`;
          } else {
            reply({ ok: false, error: 'Unknown Queues op' });
            break;
          }
          this.api.get<Record<string, unknown>>(qPath, undefined, { silent: true }).subscribe({
            next: (res) => reply({ ok: true, data: res ?? {} }),
            error: () => reply({ ok: false, error: 'Queues inspector not available' }),
          });
          break;
        }
        case 'PS_D1_REQUEST': {
          // D1 manager — mirrors the PS_QUEUE bridge. Proxies read-only D1 resource discovery to
          // /api/admin/d1/* (super-admin; list + Overview metadata only, never query/write/restore).
          const iframe = this.iframeEl;
          const cid = msg.correlationId;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_D1_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          const op = msg.op;
          const onOk = (res: Record<string, unknown> | null): void =>
            reply({ ok: true, data: res ?? {} });
          const onErr = (): void => reply({ ok: false, error: 'D1 manager not available' });
          if (op === 'databases') {
            this.api
              .get<Record<string, unknown>>('/admin/d1/databases', undefined, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else if (op === 'overview') {
            if (!msg.databaseId) {
              reply({ ok: false, error: 'No database id' });
              break;
            }
            this.api
              .get<
                Record<string, unknown>
              >(`/admin/d1/${encodeURIComponent(msg.databaseId)}/overview`, undefined, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else if (op === 'tables') {
            // Read-only schema catalog (sqlite_master) — never makes the DB unavailable. Column details
            // are parsed client-side from each object's CREATE SQL (CF's /query authorizer blocks PRAGMA).
            if (!msg.databaseId) {
              reply({ ok: false, error: 'No database id' });
              break;
            }
            this.api
              .get<
                Record<string, unknown>
              >(`/admin/d1/${encodeURIComponent(msg.databaseId)}/tables`, undefined, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else if (op === 'insights') {
            // Overview insights — per-table row counts (one bounded round-trip) + structural counts.
            // Read-only; the client derives the plain-language takeaways. Super-admin + flag-dark.
            if (!msg.databaseId) {
              reply({ ok: false, error: 'No database id' });
              break;
            }
            this.api
              .get<
                Record<string, unknown>
              >(`/admin/d1/${encodeURIComponent(msg.databaseId)}/insights`, undefined, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else if (op === 'export') {
            // SQL-dump export — a read of the DB into a .sql dump (briefly makes the DB unavailable).
            // POST the scope + resume bookmark; the endpoint is super-admin + flag-dark server-side.
            if (!msg.databaseId) {
              reply({ ok: false, error: 'No database id' });
              break;
            }
            const body: Record<string, unknown> = {};
            if (msg.tables?.length) body['tables'] = msg.tables;
            if (msg.schemaOnly) body['schemaOnly'] = true;
            if (msg.dataOnly) body['dataOnly'] = true;
            if (msg.currentBookmark) body['currentBookmark'] = msg.currentBookmark;
            this.api
              .post<
                Record<string, unknown>
              >(`/admin/d1/${encodeURIComponent(msg.databaseId)}/export`, body, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else if (op === 'explain') {
            // "Explain this table" — the server re-fetches the table's DDL and returns a Workers-AI
            // plain-English summary. Read-only (never row data). Super-admin + flag-dark server-side.
            if (!msg.databaseId || !msg.table) {
              reply({ ok: false, error: 'A database and table are required' });
              break;
            }
            this.api
              .post<
                Record<string, unknown>
              >(`/admin/d1/${encodeURIComponent(msg.databaseId)}/explain-table`, { table: msg.table }, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else if (op === 'profile') {
            // "Profile table" — one bounded single-scan aggregate → per-column stats + scan cost.
            // Read-only; columns come from the server-fetched DDL. Super-admin + flag-dark server-side.
            if (!msg.databaseId || !msg.table) {
              reply({ ok: false, error: 'A database and table are required' });
              break;
            }
            this.api
              .post<
                Record<string, unknown>
              >(`/admin/d1/${encodeURIComponent(msg.databaseId)}/profile-table`, { table: msg.table }, { silent: true })
              .subscribe({ next: onOk, error: onErr });
          } else {
            reply({ ok: false, error: 'Unknown D1 op' });
          }
          break;
        }
        case 'PS_VEC_REQUEST': {
          // Vectorize inspector — mirrors the PS_KV/PS_R2 bridge. Proxies read-only index inspection
          // to /api/admin/vectorize/* (super-admin; list + describe only, never query/insert/delete).
          const iframe = this.iframeEl;
          const cid = msg.correlationId;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_VEC_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          const op = msg.op;
          let vecPath: string;
          if (op === 'indexes') {
            vecPath = '/admin/vectorize/indexes';
          } else if (op === 'index') {
            if (!msg.name) {
              reply({ ok: false, error: 'No index name' });
              break;
            }
            vecPath = `/admin/vectorize/indexes/${encodeURIComponent(msg.name)}`;
          } else {
            reply({ ok: false, error: 'Unknown Vectorize op' });
            break;
          }
          this.api.get<Record<string, unknown>>(vecPath, undefined, { silent: true }).subscribe({
            next: (res) => reply({ ok: true, data: res ?? {} }),
            error: () => reply({ ok: false, error: 'Vectorize inspector not available' }),
          });
          break;
        }
        case 'PS_R2_REQUEST': {
          // R2 inspector — mirrors the PS_KV bridge. Proxies read-only object inspection to
          // /api/admin/r2/* (super-admin, account-level; the worker enforces super-admin + a bucket
          // allowlist and returns 404-dark when unavailable). Never fetches object bodies.
          const iframe = this.iframeEl;
          const cid = msg.correlationId;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_R2_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          const op = msg.op;
          let r2Path: string;
          const r2Params: Record<string, string> = {};
          if (op === 'buckets') {
            r2Path = '/admin/r2/buckets';
          } else if (op === 'objects') {
            if (!msg.bucket) {
              reply({ ok: false, error: 'No R2 bucket' });
              break;
            }
            r2Path = `/admin/r2/${encodeURIComponent(msg.bucket)}/objects`;
            if (msg.prefix) r2Params['prefix'] = msg.prefix;
            if (msg.cursor) r2Params['cursor'] = msg.cursor;
          } else if (op === 'object') {
            if (!msg.bucket || !msg.key) {
              reply({ ok: false, error: 'Missing bucket or key' });
              break;
            }
            r2Path = `/admin/r2/${encodeURIComponent(msg.bucket)}/object`;
            r2Params['key'] = msg.key;
          } else {
            reply({ ok: false, error: 'Unknown R2 op' });
            break;
          }
          this.api
            .get<Record<string, unknown>>(
              r2Path,
              Object.keys(r2Params).length ? r2Params : undefined,
              {
                silent: true,
              },
            )
            .subscribe({
              next: (res) => reply({ ok: true, data: res ?? {} }),
              error: () => reply({ ok: false, error: 'R2 inspector not available' }),
            });
          break;
        }
        case 'PS_KV_REQUEST': {
          // KV inspector — the embedded editor has no cross-origin session, so it asks US (we hold
          // the ApiService bearer) to read the platform KV via /api/admin/kv/* (super-admin, read-only,
          // account-level — not site-scoped). Reply with PS_KV_RESPONSE. Mirrors the PS_SQL bridge; the
          // worker enforces super-admin + a binding allowlist and returns 404 (dark) when unavailable.
          const iframe = this.iframeEl;
          const cid = msg.correlationId;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_KV_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          const op = msg.op;
          let kvPath: string;
          const kvParams: Record<string, string> = {};
          if (op === 'namespaces') {
            kvPath = '/admin/kv/namespaces';
          } else if (op === 'keys') {
            if (!msg.binding) {
              reply({ ok: false, error: 'No KV binding' });
              break;
            }
            kvPath = `/admin/kv/${encodeURIComponent(msg.binding)}/keys`;
            if (msg.prefix) kvParams['prefix'] = msg.prefix;
            if (msg.cursor) kvParams['cursor'] = msg.cursor;
          } else if (op === 'value') {
            if (!msg.binding || !msg.key) {
              reply({ ok: false, error: 'Missing binding or key' });
              break;
            }
            kvPath = `/admin/kv/${encodeURIComponent(msg.binding)}/value`;
            kvParams['key'] = msg.key;
          } else if (op === 'put') {
            // WRITE a value (super-admin, size-capped, audited server-side). KV is eventually consistent.
            if (!msg.binding || !msg.key || typeof msg.value !== 'string') {
              reply({ ok: false, error: 'Missing binding, key, or value' });
              break;
            }
            const body: Record<string, unknown> = { key: msg.key, value: msg.value };
            if (typeof msg.expirationTtl === 'number') body['expirationTtl'] = msg.expirationTtl;
            if (msg.clearExpiration === true) body['clearExpiration'] = true;
            this.api
              .put<
                Record<string, unknown>
              >(`/admin/kv/${encodeURIComponent(msg.binding)}/value`, body, { silent: true })
              .subscribe({
                next: (res) => reply({ ok: true, data: res ?? {} }),
                error: () => reply({ ok: false, error: 'The write failed.' }),
              });
            break;
          } else if (op === 'delete') {
            // DELETE a key (super-admin, audited server-side). KV.delete is idempotent + eventually consistent.
            if (!msg.binding || !msg.key) {
              reply({ ok: false, error: 'Missing binding or key' });
              break;
            }
            this.api
              .delete<
                Record<string, unknown>
              >(`/admin/kv/${encodeURIComponent(msg.binding)}/value?key=${encodeURIComponent(msg.key)}`, { silent: true })
              .subscribe({
                next: (res) => reply({ ok: true, data: res ?? {} }),
                error: () => reply({ ok: false, error: 'The delete failed.' }),
              });
            break;
          } else {
            reply({ ok: false, error: 'Unknown KV op' });
            break;
          }
          this.api
            .get<Record<string, unknown>>(
              kvPath,
              Object.keys(kvParams).length ? kvParams : undefined,
              {
                silent: true,
              },
            )
            .subscribe({
              next: (res) => reply({ ok: true, data: res ?? {} }),
              error: () => reply({ ok: false, error: 'KV inspector not available' }),
            });
          break;
        }
        case 'PS_SQL_REQUEST': {
          // D1-manager console — the embedded editor has no cross-origin session, so it asks US to
          // run ONE statement. READS (default) → POST /sql/exec (SELECT/EXPLAIN/WITH/PRAGMA); WRITES
          // (msg.write) → POST /sql/exec-write (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE). BOTH are
          // super-admin-gated server-side (AL-792); the write path denies platform tables + needs
          // confirm for destructive statements. We forward the worker's envelope verbatim; a 403 /
          // rejection surfaces as `error`. Mirrors the PS_DATA bridge.
          const iframe = this.iframeEl;
          const site = this.currentSite;
          const cid = msg.correlationId;
          const query = typeof msg.query === 'string' ? msg.query : '';
          const isWrite = msg.write === true;
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_SQL_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          if (!site) {
            reply({ ok: false, error: 'No site selected' });
            break;
          }
          const path = isWrite ? `/sites/${site.id}/sql/exec-write` : `/sites/${site.id}/sql/exec`;
          // Forward positional bind params when present — the worker BINDS them (never
          // concatenates). Both endpoints accept `params`; the grid's typed row editors rely on
          // this for parameterized INSERT/UPDATE/DELETE.
          const params = Array.isArray(msg.params) ? msg.params : undefined;
          const reqBody = isWrite
            ? { statement: query, confirm: msg.confirm === true, ...(params ? { params } : {}) }
            : { query, ...(params ? { params } : {}) };
          this.api
            .post<{
              ok?: boolean;
              columns?: string[];
              rows?: unknown[];
              rows_affected?: number;
              last_row_id?: number | null;
              needs_confirm?: boolean;
              duration_ms?: number;
              // D1 query-cost meta (`/sql/exec` returns these) — forwarded so the editor's
              // SQL console shows rows read/written + an expensive-scan warning. Null when
              // the runtime omits them (never fabricated as 0).
              rows_read?: number | null;
              rows_written?: number | null;
              error?: string;
            }>(path, reqBody, { silent: true })
            .subscribe({
              next: (res) =>
                reply({
                  ok: res?.ok ?? true,
                  columns: res?.columns ?? [],
                  rows: res?.rows ?? [],
                  rows_affected: res?.rows_affected,
                  last_row_id: res?.last_row_id,
                  duration_ms: res?.duration_ms,
                  rows_read: res?.rows_read ?? null,
                  rows_written: res?.rows_written ?? null,
                  ...(res?.needs_confirm ? { needs_confirm: true } : {}),
                  ...(res?.error ? { error: res.error } : {}),
                }),
              error: (e: unknown) => {
                const status = (e as { status?: number })?.status;
                reply({
                  ok: false,
                  error:
                    status === 403
                      ? 'The SQL console is restricted to platform administrators.'
                      : status === 400
                        ? isWrite
                          ? 'Statement rejected — a protected platform table, or a destructive statement needs confirmation.'
                          : 'Query rejected — read-only (SELECT / EXPLAIN / WITH / PRAGMA) only.'
                        : isWrite
                          ? 'Statement failed.'
                          : 'Query failed.',
                });
              },
            });
          break;
        }
        case 'PS_NL2SQL_REQUEST': {
          // AI SQL assistant — the editor asks US to translate a natural-language question to SQL.
          // Forward to POST /sites/:id/sql/nl2sql; the worker is super-admin-gated (AL-792), grounds
          // the model on the REAL server-fetched schema, and returns SQL for REVIEW (never executed).
          // We hand back { ok, sql, model } or a friendly error; a 403/404/502 maps to a clear message.
          const iframe = this.iframeEl;
          const site = this.currentSite;
          const cid = msg.correlationId;
          const question = typeof msg.question === 'string' ? msg.question : '';
          const reply = (payload: Record<string, unknown>): void => {
            iframe?.contentWindow?.postMessage(
              { type: 'PS_NL2SQL_RESPONSE', correlationId: cid, ...payload },
              EDITOR_BASE,
            );
          };
          if (!site) {
            reply({ ok: false, error: 'No site selected' });
            break;
          }
          this.api
            .post<{
              ok?: boolean;
              sql?: string;
              model?: string;
              error?: string;
            }>(`/sites/${site.id}/sql/nl2sql`, { question }, { silent: true })
            .subscribe({
              next: (res) =>
                reply({
                  ok: res?.ok ?? true,
                  sql: res?.sql ?? '',
                  model: res?.model ?? '',
                  ...(res?.error ? { error: res.error } : {}),
                }),
              error: (e: unknown) => {
                const status = (e as { status?: number })?.status;
                reply({
                  ok: false,
                  error:
                    status === 403
                      ? 'The SQL console is restricted to platform administrators.'
                      : status === 404
                        ? 'Site not found.'
                        : status === 502
                          ? 'The AI assistant is temporarily unavailable — try again in a moment.'
                          : status === 400
                            ? 'Please enter a shorter question.'
                            : 'Could not generate SQL.',
                });
              },
            });
          break;
        }
        case 'PS_TOAST': {
          // Item 44 — editor toast surfaces in the admin toast layer too.
          // suppressMirror prevents the mirror effect from echoing it back.
          this.suppressMirror = true;
          try {
            const kind = msg.kind ?? msg.level ?? 'info';
            const text = msg.message ?? '';
            const id =
              kind === 'error'
                ? this.toast.error(text)
                : kind === 'success'
                  ? this.toast.success(text)
                  : kind === 'warning'
                    ? this.toast.warning(text)
                    : this.toast.info(text);
            this.mirroredToastIds.add(id);
          } finally {
            this.suppressMirror = false;
          }
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', this.messageHandler);
  }

  /**
   * Item 43 — register a callback that receives every `PS_DEPLOY_REQUEST`
   * coming back from the editor. Returns an unsubscribe function. Only one
   * consumer is supported at a time — re-registering replaces the prior.
   */
  registerDeployHandler(
    fn:
      | ((req: {
          files: Record<string, string>;
          chat?: { messages: unknown[]; description?: string; exportDate?: string };
        }) => void)
      | null,
  ): () => void {
    this.deployHandler = fn;
    return () => {
      if (this.deployHandler === fn) this.deployHandler = null;
    };
  }

  private detachMessageListener(): void {
    if (!this.messageHandler) return;
    window.removeEventListener('message', this.messageHandler);
    this.messageHandler = null;
  }

  private uploadFiles(
    files: Record<string, string>,
    chat?: { messages: unknown[]; description?: string; exportDate?: string },
  ): void {
    const site = this.currentSite;
    if (!site) {
      this.saving.set(false);
      return;
    }
    const entries = Object.entries(files);
    if (entries.length === 0) {
      this.saving.set(false);
      this.toast.error('No files received from the editor');
      return;
    }
    const fileList = entries.map(([filePath, content]) => ({
      path: filePath.replace(/^\/home\/project\//, ''),
      content,
    }));
    const chatExport = chat || {
      messages: [],
      description: site.business_name ?? site.slug,
      exportDate: new Date().toISOString(),
    };
    this.api.publishFromBolt(site.id, site.slug, fileList, chatExport).subscribe({
      next: () => {
        this.saving.set(false);
        this.toast.success(`Deployed ${fileList.length} files successfully`);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        const e = err as { error?: { error?: { message?: string }; message?: string } };
        const message = e?.error?.error?.message || e?.error?.message || 'Unknown error';
        this.toast.error('Deploy failed: ' + message);
      },
    });
  }
}
