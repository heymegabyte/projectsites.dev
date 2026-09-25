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
 *   (PS_BOLT_READY / PS_APP_RUNNING / PS_FILES_READY / PS_GENERATION_STATUS).
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
  /** PS_KV_REQUEST (KV inspector): which read op to proxy to /api/admin/kv/*. */
  readonly op?: 'namespaces' | 'keys' | 'value';
  /** PS_KV_REQUEST: the KV binding name (required for the keys + value ops). */
  readonly binding?: string;
  /** PS_KV_REQUEST (keys op): key-name prefix filter. */
  readonly prefix?: string;
  /** PS_KV_REQUEST (keys op): opaque pagination cursor from the previous page. */
  readonly cursor?: string;
  /** PS_KV_REQUEST (value op): the exact key to fetch. */
  readonly key?: string;
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
  private deployHandler: ((req: { files: Record<string, string>; chat?: { messages: unknown[]; description?: string; exportDate?: string } }) => void) | null = null;
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
      frame.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
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
    if (opts.line && Number.isFinite(opts.line) && opts.line > 0) params.set('line', String(opts.line));
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
      { type: 'PS_OPEN_SNAPSHOT', snapshot_id: snapshotId, slug: site.slug, correlationId: crypto.randomUUID() },
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
      iframe.contentWindow!.postMessage(
        { type: 'PS_LIST_FILES', correlationId },
        EDITOR_BASE,
      );
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

  private dismissVeil(_reason: 'app_running' | 'timeout' | 'chat_grace'): void {
    if (this.editorReady()) return;
    this.loadingPhase.set(4);
    this.editorReady.set(true);
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.hardTimeout) { clearTimeout(this.hardTimeout); this.hardTimeout = null; }
    if (this.softTimeout) { clearTimeout(this.softTimeout); this.softTimeout = null; }
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
          // hang if no preview-ready arrives — in the common case PS_APP_RUNNING /
          // preview_ready fires first and dismisses cleanly before the grace elapses.
          this.loadingPhase.set(2);
          this.loadingStage.set('Preparing your site');
          if (!this.softTimeout) {
            this.softTimeout = setTimeout(() => this.dismissVeil('chat_grace'), CHAT_GRACE_MS);
          }
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
          const path = table
            ? `/sites/${site.id}/data-overview/${encodeURIComponent(table)}`
            : `/sites/${site.id}/data-overview`;
          this.api
            .get<{ data?: unknown }>(path, table ? { limit: '25' } : undefined, { silent: true })
            .subscribe({
              // Tell the editor whether the D1-manager SQL console is available (super-admin only) —
              // merged into the OVERVIEW reply so it never renders a console that would only 403.
              next: (res) => {
                const data = (res?.data ?? null) as Record<string, unknown> | null;
                reply({
                  data: data && !table ? { ...data, canRunSql: this.superAdmin() } : data,
                });
              },
              error: () => reply({ error: 'Failed to load data' }),
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
          } else {
            reply({ ok: false, error: 'Unknown KV op' });
            break;
          }
          this.api
            .get<Record<string, unknown>>(kvPath, Object.keys(kvParams).length ? kvParams : undefined, {
              silent: true,
            })
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
        case 'PS_TOAST': {
          // Item 44 — editor toast surfaces in the admin toast layer too.
          // suppressMirror prevents the mirror effect from echoing it back.
          this.suppressMirror = true;
          try {
            const kind = msg.kind ?? msg.level ?? 'info';
            const text = msg.message ?? '';
            const id =
              kind === 'error' ? this.toast.error(text)
              : kind === 'success' ? this.toast.success(text)
              : kind === 'warning' ? this.toast.warning(text)
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
    fn: ((req: { files: Record<string, string>; chat?: { messages: unknown[]; description?: string; exportDate?: string } }) => void) | null,
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
