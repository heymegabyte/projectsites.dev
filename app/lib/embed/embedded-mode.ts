/**
 * Embedded mode detection and postMessage bridge for bolt.diy.
 *
 * When bolt.diy is loaded inside an iframe on projectsites.dev,
 * this module handles communication between the parent (Angular admin)
 * and the child (bolt.diy React app) via postMessage.
 *
 * @module embed/embedded-mode
 */

import type { DirectoryNode, FileSystemTree } from '@webcontainer/api';

// ── Types ────────────────────────────────────────────────────

/** Parent → Child messages */
export interface SubmitPromptMessage {
  type: 'PS_SUBMIT_PROMPT';
  prompt: string;
  siteId: string;
  slug: string;
  correlationId: string;
}

export interface ImportFilesMessage {
  type: 'PS_IMPORT_FILES';
  files: Record<string, string>; // path → content (text only)
  siteId: string;
  slug: string;
  correlationId: string;
}

export interface RequestFilesMessage {
  type: 'PS_REQUEST_FILES';
  includeChat?: boolean;
  correlationId: string;
}

export interface LoadBuildContextMessage {
  type: 'PS_LOAD_BUILD_CONTEXT';
  contextUrl: string;
  siteId: string;
  slug: string;
  correlationId: string;
}

/** Child → Parent messages */
export interface BoltReadyMessage {
  type: 'PS_BOLT_READY';
}

export interface FilesReadyMessage {
  type: 'PS_FILES_READY';
  files: Record<string, string>;
  chat?: { messages: unknown[]; description?: string; exportDate: string };
  correlationId: string;
}

export interface GenerationStatusMessage {
  type: 'PS_GENERATION_STATUS';
  status: 'idle' | 'generating' | 'complete' | 'error';
  error?: string;
  correlationId: string;
}

/**
 * Editor runtime error — relayed to admin so it can write to `audit_logs`
 * with `action: 'editor.runtime_error'` (item 46). Sourced from
 * `window.onerror`, `window.onunhandledrejection`, and WebContainer error
 * events. Used by the admin's `BoltEmbedService` → `POST /api/audit-logs/editor-error`.
 */
export interface PSErrorMessage {
  type: 'PS_ERROR';
  code: string;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  requestId: string;
}

/**
 * Funnel-event relay — admin already has PostHog loaded with the right
 * project keys + tenant context. bolt.diy postMessages the event name +
 * props, admin's `TelemetryService.capture()` fires it (item 48).
 */
export interface PSTelemetryMessage {
  type: 'PS_TELEMETRY';
  event: string;
  props?: Record<string, unknown>;
}

/**
 * Toast bridge — surfaces "Editor recovered" + similar admin-facing
 * messages after auto-recovery (item 47). Also used bi-directionally by
 * item 44 so admin-side toasts mirror inside the editor and vice-versa.
 * `kind` is the canonical field; `level` is kept as an alias for the
 * original Phase-2 emitters.
 */
export interface PSToastMessage {
  type: 'PS_TOAST';
  kind?: 'info' | 'success' | 'warning' | 'error';
  level?: 'info' | 'success' | 'warning' | 'error';
  message: string;
  correlationId?: string;
}

/**
 * Parent → Child (item 41): rebase the workbench to a snapshot. The child
 * resolves the snapshot's chat-export from the existing `by-slug/chat`
 * endpoint and runs the import-chat flow to load that revision's files.
 */
export interface OpenSnapshotMessage {
  type: 'PS_OPEN_SNAPSHOT';
  snapshot_id: string;
  slug?: string;
  correlationId: string;
}

/**
 * Parent → Child (item 42): jump to a specific file + optional 1-based line.
 * Used by the admin's "Open IDE" deep-links and Cmd+K palette file results.
 */
export interface OpenFileMessage {
  type: 'PS_OPEN_FILE';
  file: string;
  line?: number;
  correlationId: string;
}

/** Parent → Child (item 45): enumerate every text file in the workbench. */
export interface ListFilesMessage {
  type: 'PS_LIST_FILES';
  correlationId: string;
}

/**
 * Child → Parent (item 45): response to `PS_LIST_FILES`. Paths are
 * workbench-relative; size is the UTF-8 byte length of the text content.
 */
export interface FilesListMessage {
  type: 'PS_FILES_LIST';
  correlationId: string;
  files: { path: string; size: number }[];
}

/**
 * Child → Parent (item 43): replaces bolt.diy's standalone deploy flow.
 * Admin runs the actual deploy via its own site-deploy API so deploys land
 * in the same audit log as everything else.
 */
export interface DeployRequestMessage {
  type: 'PS_DEPLOY_REQUEST';
  files: Record<string, string>;
  chat?: { messages: unknown[]; description?: string; exportDate: string };
  correlationId: string;
}

/**
 * Child → Parent (AL-004 Data tab): ask the admin to read the site's REAL data
 * via `/api/sites/:id/data-overview[/:table]`. The embedded editor has no
 * cross-origin session, so the admin (which holds `selectedSite` + the bearer)
 * makes the authed call and replies with {@link DataResponseMessage}. Omit
 * `table` for the table-list overview; set it to browse one table's recent rows.
 */
export interface DataRequestMessage {
  type: 'PS_DATA_REQUEST';
  table?: string;
  correlationId: string;
}

/** One row of the data-overview table list. */
export interface DataOverviewTable {
  key: string;
  label: string;
  description: string;
  columns: string[];
  row_count: number;
  browsable: boolean;
}

/**
 * Parent → Child (AL-004 Data tab): the admin's reply to {@link DataRequestMessage}.
 * `data` mirrors the worker's `data` envelope — `{ tables }` for the overview,
 * `{ table, columns, rows }` for a browse. `error` is set when the authed call
 * failed (no site selected, network, 4xx).
 */
export interface DataResponseMessage {
  type: 'PS_DATA_RESPONSE';
  correlationId?: string;
  table?: string;
  data?: {
    tables?: DataOverviewTable[];
    table?: string;
    columns?: string[];
    rows?: Record<string, unknown>[];

    /**
     * True when the signed-in admin is a platform super-admin → the D1 manager unlocks the
     * read-only SQL console (arbitrary SELECT/PRAGMA over the site's D1 via {@link SqlRequestMessage}).
     * A normal site owner gets `false` → the curated, org-scoped table browser only (the raw
     * console reads the shared multi-tenant DB, so it MUST stay super-admin-gated — AL-792).
     */
    canRunSql?: boolean;
  } | null;
  error?: string;
}

/**
 * Child → Parent (D1 manager): ask the admin to run ONE SQL statement against the site's D1.
 * READS (default, `write` unset) go to `POST /api/sites/:id/sql/exec` (SELECT/EXPLAIN/WITH/PRAGMA
 * allowlist); WRITES (`write:true`) go to `POST /api/sites/:id/sql/exec-write`
 * (CREATE/DROP/ALTER TABLE + INSERT/UPDATE/DELETE/REPLACE). BOTH are super-admin-gated (the shared
 * multi-tenant DB — AL-792), so a non-super-admin gets a 403 surfaced as {@link SqlResponseMessage.error}.
 * The write path refuses to touch platform tables (denylist) and rejects destructive statements
 * (DROP/ALTER, or DELETE/UPDATE without WHERE) unless `confirm:true` — the editor's type-to-confirm.
 * Outerbase-Studio-inspired: table list from `sqlite_master`, schema via `PRAGMA table_info`,
 * create/drop table, row CRUD, and free-form queries — all through this one bridge message.
 */
export interface SqlRequestMessage {
  type: 'PS_SQL_REQUEST';
  query: string;
  correlationId: string;

  /** When true, route to the WRITE endpoint (CREATE/DROP/ALTER/INSERT/UPDATE/DELETE). Default: read. */
  write?: boolean;

  /** Required `true` for destructive writes (DROP/ALTER, unscoped DELETE/UPDATE) — the type-to-confirm. */
  confirm?: boolean;
}

/** Parent → Child: the admin's reply to {@link SqlRequestMessage} (mirrors the sql/exec[-write] envelope). */
export interface SqlResponseMessage {
  type: 'PS_SQL_RESPONSE';
  correlationId?: string;
  ok?: boolean;

  /** Read results. */
  columns?: string[];
  rows?: Record<string, unknown>[];

  /** Write results. */
  rows_affected?: number;
  last_row_id?: number | null;

  /** Set when the server refused a destructive write pending `confirm:true` — the UI prompts. */
  needs_confirm?: boolean;
  duration_ms?: number;
  error?: string;
}

export type ParentToChildMessage =
  | SubmitPromptMessage
  | ImportFilesMessage
  | RequestFilesMessage
  | LoadBuildContextMessage
  | OpenSnapshotMessage
  | OpenFileMessage
  | ListFilesMessage
  | DataResponseMessage
  | SqlResponseMessage
  | PSToastMessage;
export type ChildToParentMessage =
  | BoltReadyMessage
  | FilesReadyMessage
  | GenerationStatusMessage
  | FilesListMessage
  | DeployRequestMessage
  | DataRequestMessage
  | SqlRequestMessage
  | PSErrorMessage
  | PSTelemetryMessage
  | PSToastMessage;

// ── Allowed origins ──────────────────────────────────────────

const ALLOWED_ORIGINS = new Set(['https://projectsites.dev', 'http://localhost:4200', 'http://localhost:4300']);

// ── Detection (synchronous — must run before WebContainer boot) ──

function detectEmbedded(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const inIframe = window.parent !== window;

    if (!inIframe) {
      return false;
    }

    const hasParam = new URLSearchParams(window.location.search).has('embedded');

    /*
     * Embedded mode must SURVIVE SPA navigation (journey 2026-08-19).
     *
     * The chat-import flow navigates the document to `/chat/{id}` — a FULL
     * reload whose URL carries NO `embedded` param. The old param-only
     * detection silently turned embedded mode OFF on that reload: the
     * module-level `handleMessage` listener never attached, so the parent's
     * Save & Deploy (`PS_REQUEST_FILES`) found zero handlers and the
     * publish leg of the bridge dead-aired forever.
     *
     * An embedded session now stamps `ps_embedded=1` into localStorage at
     * first boot (param present). Any later reload inside the admin iframe
     * recovers the flag. Standalone visits are unaffected — a top-level
     * window has `inIframe === false` and never reads the stamp. The
     * origin allowlist on both sides of the bridge still gates every
     * message, so a third-party iframe can't act on the protocol.
     */
    if (hasParam) {
      try {
        window.localStorage.setItem('ps_embedded', '1');
      } catch {
        // storage may be unavailable (private mode) — param still wins this boot
      }

      return true;
    }

    try {
      return window.localStorage.getItem('ps_embedded') === '1';
    } catch {
      return false;
    }
  } catch {
    // Cross-origin access to window.parent may throw
    return false;
  }
}

/** True when bolt.diy is loaded inside a projectsites.dev iframe */
export const isEmbedded: boolean = detectEmbedded();

// ── postMessage helpers ──────────────────────────────────────

/** Send a message to the parent frame (projectsites.dev admin). */
export function postToParent(message: ChildToParentMessage): void {
  if (!isEmbedded || typeof window === 'undefined') {
    return;
  }

  // Post to all allowed origins (parent origin is unknown at send time)
  window.parent.postMessage(message, '*');
}

/** Validate that a MessageEvent comes from an allowed origin. */
function isAllowedOrigin(event: MessageEvent): boolean {
  return ALLOWED_ORIGINS.has(event.origin);
}

/** Check if a message has the PS_ prefix (our protocol). */
function isPSMessage(data: unknown): data is ParentToChildMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof (data as { type: unknown }).type === 'string' &&
    (data as { type: string }).type.startsWith('PS_')
  );
}

// ── Message listener ─────────────────────────────────────────

type MessageHandler = (message: ParentToChildMessage) => void;

const handlers: MessageHandler[] = [];

/*
 * Workbench materialization across the chat-import reload (journey
 * 2026-08-19 — the LAST rung of the editor bridge).
 *
 * The imported boltArtifact's <boltAction type="file"> blocks never reach
 * the workbench in embedded mode: importChat() creates a fresh chat and
 * does a FULL-DOCUMENT navigation, and the files store is memory-only —
 * everything is wiped on that reload. So Save & Deploy's PS_FILES_READY
 * answered with ZERO files and the publish leg could never carry content.
 *
 * Two-phase fix:
 *  - `materializeImportedFiles(messages)` parses every artifact file
 *    action from the chat export and STASHES {path → content} in
 *    sessionStorage (survives the reload).
 *  - `restoreMaterializedFiles()` — called from the module init below —
 *    drains the stash into workbenchStore.createFile() on the fresh
 *    document, so getTextFiles() (and therefore PS_FILES_READY) finally
 *    carries the real site files.
 *
 * sessionStorage is per-tab and per-origin; a standalone bolt visit (or a
 * different embed) never sees the stash. The regex mirrors
 * FileDiffBadges.tsx (tolerates unterminated actions, strips code fences).
 */
const MATERIALIZED_KEY = 'ps_materialized_files';
const FILE_ACTION_RE =
  /<boltAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)(?=<\/boltAction>|<boltAction|$)/g;

export function materializeImportedFiles(messages: Array<{ content?: string }>): number {
  try {
    const files: Record<string, string> = {};

    for (const m of messages) {
      const content = typeof m?.content === 'string' ? m.content : '';
      FILE_ACTION_RE.lastIndex = 0;

      let match: RegExpExecArray | null;

      while ((match = FILE_ACTION_RE.exec(content)) !== null) {
        const filePath = (match[1] ?? '').trim();

        if (!filePath) {
          continue;
        }

        const body = (match[2] ?? '').replace(/^\s*```\w*\n?/, '').replace(/\n```\s*$/, '');
        files[filePath] = body;
      }
    }

    const count = Object.keys(files).length;

    if (count > 0) {
      window.sessionStorage.setItem(MATERIALIZED_KEY, JSON.stringify(files));
    }

    return count;
  } catch {
    return 0;
  }
}

export function restoreMaterializedFiles(): void {
  try {
    const raw = window.sessionStorage.getItem(MATERIALIZED_KEY);

    if (!raw) {
      return;
    }

    window.sessionStorage.removeItem(MATERIALIZED_KEY);

    const files = JSON.parse(raw) as Record<string, string>;
    import('~/lib/stores/workbench')
      .then(({ workbenchStore }) => {
        /*
         * setVirtualFile — NOT createFile. createFile awaits the WebContainer
         * promise which never settles in embedded mode, so an await-based
         * restore hangs forever and getTextFiles() stays empty.
         */
        let restored = 0;

        for (const [filePath, content] of Object.entries(files)) {
          try {
            workbenchStore.setVirtualFile(filePath, content);
            restored++;
          } catch {
            // a single bad path must not abort the rest
          }
        }

        if (restored > 0) {
          postToParent({
            type: 'PS_TOAST',
            kind: 'info',
            level: 'info',
            message: `Editor workbench restored (${restored} files) — Save & Deploy now carries the site`,
          });
        }

        /*
         * If this embed is cross-origin-isolated, WebContainer CAN boot — so mount
         * the imported project into its filesystem and run `npm install` + `npm run
         * dev`, which makes the live Preview actually spin up (Brian 2026-08-21 —
         * "ensure the npm command runs that causes the Preview to display"). Files
         * were only written to the in-memory store above (for the FileTree +
         * Save & Deploy bridge); the dev server needs them on the REAL WC disk. A
         * non-isolated embed stays materialization-only — WebContainer never boots.
         */
        const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

        if (isolated && restored > 0) {
          void spinUpWebContainerPreview(files);
        }
      })
      .catch(() => {
        // workbench store failed to load — the stash is already drained; fail soft
      });
  } catch {
    // malformed stash — drop it
  }
}

/** Nest flat `{relPath -> contents}` into the WebContainer `FileSystemTree` shape. */
function filesToTree(files: Record<string, string>): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const [rawPath, contents] of Object.entries(files)) {
    const parts = rawPath.replace(/^\/+/, '').split('/').filter(Boolean);

    if (parts.length === 0) {
      continue;
    }

    let node: FileSystemTree = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];

      if (!node[dir]) {
        node[dir] = { directory: {} };
      }

      node = (node[dir] as DirectoryNode).directory;
    }

    node[parts[parts.length - 1]] = { file: { contents } };
  }

  return tree;
}

/**
 * Mount the imported project into WebContainer and start its dev server so the
 * embedded editor's Preview displays the running site. Fire-and-forget — every
 * phase toasts progress to the admin shell; failures fail soft.
 *
 * @remarks Impure — mounts to the WebContainer fs and spawns npm processes.
 */
async function spinUpWebContainerPreview(files: Record<string, string>): Promise<void> {
  try {
    const [{ webcontainer }, { workbenchStore }] = await Promise.all([
      import('~/lib/webcontainer'),
      import('~/lib/stores/workbench'),
    ]);
    const wc = await webcontainer; // resolves only when the isolated embed booted

    await wc.mount(filesToTree(files));

    // Pick the dev script (dev → start → serve), default `dev`.
    let devScript = 'dev';

    try {
      const scripts = (JSON.parse(files['package.json'] ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {};
      devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : 'dev';
    } catch {
      // no/invalid package.json — fall back to `dev`
    }

    /*
     * Prefer the BOLT SHELL TERMINAL so `npm install` + Vite's ready banner
     * (`VITE vX ready … Local: …`) + HMR update logs stream into the VISIBLE
     * terminal — that is the running dev server whose watcher live-reloads the
     * Preview on every file save (Brian 2026-08-21). Fall back to a detached
     * `spawn` only if the terminal never attaches, so the Preview still boots.
     */
    const shell = workbenchStore.boltTerminal;
    const shellReady = await Promise.race([
      shell.ready().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
    ]);

    postToParent({ type: 'PS_TOAST', kind: 'info', level: 'info', message: 'Installing dependencies…' });

    if (shellReady) {
      const install = await shell.executeCommand('ps-spinup', 'npm install');

      if (install && install.exitCode !== 0) {
        postToParent({
          type: 'PS_TOAST',
          kind: 'error',
          level: 'error',
          message: 'npm install failed — see the terminal',
        });
        return;
      }

      postToParent({ type: 'PS_TOAST', kind: 'info', level: 'info', message: 'Starting dev server…' });

      /*
       * Long-running — fire-and-forget so Vite keeps running + `server-ready`
       * (PreviewsStore) surfaces the URL into the Preview tab.
       */
      void shell.executeCommand('ps-spinup', `npm run ${devScript}`);

      return;
    }

    /*
     * Fallback (terminal never attached): detached spawn — no visible output,
     * but the dev server + Preview still come up.
     */
    const install = await wc.spawn('npm', ['install']);

    if ((await install.exit) !== 0) {
      postToParent({ type: 'PS_TOAST', kind: 'error', level: 'error', message: 'npm install failed' });
      return;
    }

    postToParent({ type: 'PS_TOAST', kind: 'info', level: 'info', message: 'Starting dev server…' });
    await wc.spawn('npm', ['run', devScript]);
  } catch (err) {
    postToParent({
      type: 'PS_TOAST',
      kind: 'error',
      level: 'error',
      message: 'Preview failed to start: ' + String(err).slice(0, 90),
    });
  }
}

/** Register a handler for incoming parent messages. Returns an unsubscribe function. */
export function onParentMessage(handler: MessageHandler): () => void {
  handlers.push(handler);

  return () => {
    const idx = handlers.indexOf(handler);

    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  };
}

function handleMessage(event: MessageEvent): void {
  /*
   * (Removed the per-message "[embed] Received postMessage" debug warn — it
   * fired on EVERY PS_ message in embedded mode, spamming the editor console.
   * The origin-reject + handler-error logs below remain — those are rare,
   * diagnostic, and security-relevant.)
   */
  if (!isAllowedOrigin(event)) {
    if (isEmbedded && event.data?.type?.startsWith?.('PS_')) {
      console.warn('[embed] REJECTED — origin not allowed:', event.origin, 'Allowed:', [...ALLOWED_ORIGINS]);
    }

    return;
  }

  if (!isPSMessage(event.data)) {
    return;
  }

  for (const handler of handlers) {
    try {
      handler(event.data);
    } catch (err) {
      console.warn('[embed] Handler error:', err);
    }
  }
}

// ── Convenience emitters (items 46-48) ───────────────────────

/**
 * Relay an editor runtime error to the admin so it can be persisted to
 * `audit_logs` with `action: 'editor.runtime_error'`. Safe to call from
 * any handler — silently no-ops outside embedded mode.
 */
export function postErrorToParent(input: Omit<PSErrorMessage, 'type' | 'requestId'> & { requestId?: string }): void {
  postToParent({
    type: 'PS_ERROR',
    code: input.code,
    message: input.message,
    stack: input.stack,
    file: input.file,
    line: input.line,
    requestId: input.requestId ?? (typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}`),
  });
}

/** Capture a PostHog event via the admin's TelemetryService. */
export function postTelemetryToParent(event: string, props?: Record<string, unknown>): void {
  postToParent({ type: 'PS_TELEMETRY', event, props });
}

/** Toast bridge — admin renders via its ToastService. */
export function postToastToParent(level: NonNullable<PSToastMessage['kind']>, message: string): void {
  /*
   * Send both `kind` (canonical) and `level` (legacy alias) so either
   * side of the bridge can match without coordination.
   */
  postToParent({ type: 'PS_TOAST', kind: level, level, message });
}

// ── Initialize ───────────────────────────────────────────────

if (isEmbedded && typeof window !== 'undefined') {
  window.addEventListener('message', handleMessage);

  // Drain any pre-navigation materialization stash into the workbench.
  restoreMaterializedFiles();

  /*
   * ROUTE-INDEPENDENT PS_REQUEST_FILES responder (journey 2026-08-19 — the
   * publish leg of the editor bridge was dead).
   *
   * The only responder lived inside Chat.client.tsx's `useEffect` — a
   * ROUTE-scoped handler. "Click to open Workbench" (or any nav) unmounts
   * the chat route, the handler unsubscribes, and a later admin-side
   * Save & Deploy (`PS_REQUEST_FILES`) reaches an EMPTY handlers array —
   * the editor never replies, the parent times out with "Save timed out",
   * and a user's editor change can never publish. The workbench store is
   * module-global and survives route nav, so answer at this always-on
   * module level instead. Chat.client.tsx's own responder handles
   * `includeChat` (chat export) — keep both; the module responder only
   * guarantees the FILES reply so a publish can never dead-air again.
   */
  onParentMessage((msg) => {
    if (msg.type !== 'PS_REQUEST_FILES') {
      return;
    }

    import('~/lib/stores/workbench')
      .then(({ workbenchStore }) => {
        const textFiles = workbenchStore.getTextFiles();
        postToParent({
          type: 'PS_FILES_READY',
          files: textFiles,
          correlationId: msg.correlationId,
        });
      })
      .catch((err) => {
        console.warn('[embed] PS_REQUEST_FILES responder failed:', err);
      });
  });

  // ── Item 46: hook window-level errors + unhandled rejections ──
  window.addEventListener('error', (event: ErrorEvent) => {
    postErrorToParent({
      code: 'window.onerror',
      message: event.message ?? 'Unknown window error',
      stack: event.error?.stack,
      file: event.filename,
      line: event.lineno,
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled promise rejection';
    const stack = reason instanceof Error ? reason.stack : undefined;
    postErrorToParent({ code: 'window.unhandledrejection', message, stack });
  });

  /*
   * Notify parent that bolt.diy is ready
   * Delay slightly to allow React to mount
   */
  requestAnimationFrame(() => {
    postToParent({ type: 'PS_BOLT_READY' });

    // Item 48: editor.boot_started — first event in the PostHog funnel.
    postTelemetryToParent('editor.boot_started', { embedded: true });
  });
}
