import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { cleanStackTrace } from '~/utils/stacktrace';
import { isEmbedded, postErrorToParent, postToastToParent, postTelemetryToParent } from '~/lib/embed/embedded-mode';

interface WebContainerContext {
  loaded: boolean;
}

/**
 * Ring buffer of the last 3 file edits — replayed after a WebContainer
 * crash so the user's in-flight work survives an auto-reboot (item 47).
 */
interface FileEdit {
  path: string;
  content: string;
  at: number;
}

const fileEditHistory: FileEdit[] = [];
const MAX_HISTORY = 3;

/** Push an edit into the recovery ring buffer (called from workbench store on save). */
export function recordFileEdit(path: string, content: string): void {
  fileEditHistory.push({ path, content, at: Date.now() });

  while (fileEditHistory.length > MAX_HISTORY) {
    fileEditHistory.shift();
  }
}

export const webcontainerContext: WebContainerContext = import.meta.hot?.data?.webcontainerContext ?? {
  loaded: false,
};

if (import.meta.hot?.data) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

function bootContainer(): Promise<WebContainer> {
  return WebContainer.boot({
    coep: 'credentialless',
    workdirName: WORK_DIR_NAME,
    forwardPreviewErrors: true, // Enable error forwarding from iframes
  });
}

async function wireContainer(instance: WebContainer): Promise<WebContainer> {
  webcontainerContext.loaded = true;

  const { workbenchStore } = await import('~/lib/stores/workbench');

  const response = await fetch('/inspector-script.js');
  const inspectorScript = await response.text();
  await instance.setPreviewScript(inspectorScript);

  instance.on('preview-message', (message) => {
    console.warn('WebContainer preview message:', message);

    if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
      const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
      const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
      const errMessage = 'message' in message ? message.message : 'Unknown error';
      const cleanedStack = cleanStackTrace(message.stack || '');

      workbenchStore.actionAlert.set({
        type: 'preview',
        title,
        description: errMessage,
        content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanedStack}`,
        source: 'preview',
      });

      // Item 46: stream every WebContainer preview error to admin's audit log.
      if (isEmbedded) {
        postErrorToParent({
          code: message.type,
          message: errMessage,
          stack: cleanedStack,
          file: message.pathname,
        });
      }
    }
  });

  return instance;
}

/**
 * Item 47: auto-recover from a WebContainer crash. Reboots the container,
 * replays the last 3 file edits, and toasts "Editor recovered" via the
 * admin's ToastService. Idempotent — concurrent calls share one promise.
 */
let recoveryInFlight: Promise<WebContainer> | null = null;

export function recoverWebContainer(reason: string): Promise<WebContainer> {
  if (recoveryInFlight) {
    return recoveryInFlight;
  }

  if (isEmbedded) {
    postErrorToParent({ code: 'webcontainer.crash', message: `WebContainer crash detected: ${reason}` });
    postTelemetryToParent('editor.webcontainer_crash', { reason });
  }

  recoveryInFlight = (async () => {
    try {
      const fresh = await bootContainer();
      const wired = await wireContainer(fresh);

      for (const edit of fileEditHistory) {
        try {
          const dir = edit.path.substring(0, edit.path.lastIndexOf('/'));

          if (dir) {
            await wired.fs.mkdir(dir, { recursive: true });
          }

          await wired.fs.writeFile(edit.path, edit.content);
        } catch (err) {
          console.warn('[webcontainer] replay failed for', edit.path, err);
        }
      }

      webcontainer = Promise.resolve(wired);

      if (import.meta.hot?.data) {
        import.meta.hot.data.webcontainer = webcontainer;
      }

      if (isEmbedded) {
        postToastToParent('success', 'Editor recovered');
        postTelemetryToParent('editor.webcontainer_recovered', { replayedEdits: fileEditHistory.length });
      }

      return wired;
    } finally {
      recoveryInFlight = null;
    }
  })();

  return recoveryInFlight;
}

if (!import.meta.env.SSR) {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

  if (!isolated) {
    /*
     * WebContainer needs SharedArrayBuffer, which requires the document to be
     * crossOriginIsolated (COOP + COEP). Standalone editor.projectsites.dev ships
     * both; the ADMIN embed is isolated only when the parent /admin shell ALSO
     * ships COEP (restored 2026-08-21) AND the iframe carries
     * allow="cross-origin-isolated". Gate on the ACTUAL flag, NOT on isEmbedded —
     * an isolated embed CAN boot, and that is exactly what makes the live Preview
     * run `npm install` / `npm run dev`. When false, skip boot; the code editor +
     * materialization publish-bridge still work, only live preview + terminal are
     * unavailable.
     */
    console.warn(
      `[webcontainer] Skipping boot — not crossOriginIsolated (embedded=${isEmbedded}); live preview + terminal unavailable`,
    );
  } else {
    webcontainer =
      import.meta.hot?.data?.webcontainer ??
      Promise.resolve()
        .then(() => bootContainer())
        .then(wireContainer)
        .catch((err: unknown) => {
          /*
           * Item 47: boot failure auto-triggers recovery once. Subsequent
           * failures bubble up so the UI can surface "Editor unavailable".
           */
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[webcontainer] boot failed; attempting recovery:', message);

          return recoverWebContainer(`boot-failure: ${message}`);
        });

    if (import.meta.hot?.data) {
      import.meta.hot.data.webcontainer = webcontainer;
    }
  }
}
