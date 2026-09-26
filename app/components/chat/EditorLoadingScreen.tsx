import { useEffect, useState } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { BOOT_POLL_MS, BOOT_SAFETY_TIMEOUT_MS, editorFilesReady, isBootReady } from '~/lib/stores/editor-boot';
import { countProjectFiles } from './site-import-status';
import { EditorLoadingVisual } from './EditorLoadingVisual';

const READY_TEXTS = ['Build a professional website for', 'What are we shipping?', 'What are we discussing?'];

/** Settle window (ms): a positive, unchanging file count for this long counts as "loaded". */
const FILES_SETTLED_MS = 1200;

/** Fallback (ms) to force-unmount if the CSS fade-out `transitionend` never fires. */
const FADE_FALLBACK_MS = 700;

/**
 * Full-surface, self-dismissing editor boot overlay. Rendered as early as
 * possible (in the root Layout, outside `ClientOnly`, so it is in the initial
 * HTML and paints before hydration) and fades out — background and all — the
 * moment the editor's files are loaded.
 *
 * Readiness, first signal to fire wins:
 * 1. **{@link editorFilesReady}** — the precise "all N project files are in the
 *    editor" signal published by the imported-site status card. (Primary.)
 * 2. **Files settled** — a positive file count unchanged for {@link FILES_SETTLED_MS}
 *    (covers non-import loads that never publish the atom).
 * 3. **Empty chat confirmed** — a NON-import chat whose input painted with zero
 *    files held across the confirm window (nothing to load).
 * 4. **{@link BOOT_SAFETY_TIMEOUT_MS}** — hard cap so a stuck environment never
 *    traps the overlay onscreen.
 *
 * @remarks An import is NEVER dismissed on the chat-ready signal alone — it
 *   waits for its files (per {@link isBootReady}), so the screen stays up
 *   through the whole file load.
 */
export function EditorLoadingScreen() {
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    /*
     * Embedded in the projectsites admin: the admin's own veil (OUTSIDE this
     * iframe) is the loading indicator. Rendering this in-iframe overlay too
     * caused a reveal-flash when that veil faded, and it re-mounted (twitched)
     * whenever the iframe re-rendered/reloaded. Suppress it entirely when
     * embedded — the opaque admin veil covers the iframe through the whole boot,
     * so there's no in-iframe element left to flash.
     */
    if (window.parent !== window) {
      setHidden(true);
      return undefined;
    }

    let finished = false;
    const params = new URLSearchParams(window.location.search);
    const isImport = params.has('slug') || params.has('importChatFrom');

    const chatReady = () =>
      READY_TEXTS.some((t) => document.body?.innerText?.includes(t)) ||
      READY_TEXTS.some((t) => !!document.querySelector(`[placeholder*="${t}"]`));

    let emptyTicks = 0;
    let lastCount = -1;
    let settleTimer: number | undefined;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      setReady(true);
    };

    // 1. Precise signal — files confirmed loaded (or any explicit mark).
    const unsubscribe = editorFilesReady.subscribe((value) => {
      if (value) {
        finish();
      }
    });

    const poll = window.setInterval(() => {
      const fileCount = countProjectFiles(workbenchStore.files.get());
      const isChatReady = chatReady();

      emptyTicks = isChatReady && fileCount === 0 ? emptyTicks + 1 : 0;

      // 2. Files settled — a positive count that stops growing.
      if (fileCount > 0 && fileCount !== lastCount) {
        lastCount = fileCount;

        if (settleTimer) {
          window.clearTimeout(settleTimer);
        }

        settleTimer = window.setTimeout(finish, FILES_SETTLED_MS);
      }

      // 3. Empty-chat confirmation (non-import only) + the atom re-check.
      if (
        isBootReady({ filesReady: editorFilesReady.get(), isImport, fileCount, chatReady: isChatReady, emptyTicks })
      ) {
        finish();
      }
    }, BOOT_POLL_MS);

    // 4. Hard safety cap.
    const safety = window.setTimeout(finish, BOOT_SAFETY_TIMEOUT_MS);

    return () => {
      unsubscribe();
      window.clearInterval(poll);

      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }

      window.clearTimeout(safety);
    };
  }, []);

  // Force-unmount if the fade-out transition never reports back.
  useEffect(() => {
    if (!ready || typeof window === 'undefined') {
      return undefined;
    }

    const fallback = window.setTimeout(() => setHidden(true), FADE_FALLBACK_MS);

    return () => window.clearTimeout(fallback);
  }, [ready]);

  if (hidden) {
    return null;
  }

  return (
    <EditorLoadingVisual
      leaving={ready}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'opacity' && ready) {
          setHidden(true);
        }
      }}
    />
  );
}
