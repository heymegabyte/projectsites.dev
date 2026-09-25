import { atom } from 'nanostores';

/**
 * True once the editor's initial project files have finished loading into the
 * workbench. Published by the imported-site status card (`SiteImportStatus`)
 * the moment its file count reaches the expected total, and read by the
 * full-surface {@link EditorLoadingScreen} boot overlay so it can fade out
 * exactly when the files are in — not merely when the chat shell paints.
 *
 * Module-level singleton: every editor open is a fresh document load
 * (`importChat` does a full-document navigation), so it resets to `false`
 * naturally without any teardown.
 */
export const editorFilesReady = atom<boolean>(false);

/** Mark the editor's initial files as fully loaded (idempotent). */
export function markEditorFilesReady(): void {
  if (!editorFilesReady.get()) {
    editorFilesReady.set(true);
  }
}

/**
 * Poll cadence (ms) for the boot overlay's fallback readiness checks.
 * @remarks Exported so tests + the overlay share one source of truth.
 */
export const BOOT_POLL_MS = 250;

/** Consecutive "empty + chat-ready" polls (~1.5s) before a fresh, file-less chat is declared ready. */
export const EMPTY_CHAT_CONFIRM_TICKS = 6;

/** Hard safety cap (ms): the overlay always dismisses by this point, even if every signal misfires. */
export const BOOT_SAFETY_TIMEOUT_MS = 30_000;

export interface BootReadinessInput {
  /** The precise "all initial files are in the editor" signal ({@link editorFilesReady}). */
  filesReady: boolean;

  /** Editor was opened to load an existing/imported site (`?slug` / `?importChatFrom`). */
  isImport: boolean;

  /** Files currently present in the editor. */
  fileCount: number;

  /** The chat input placeholder has painted (shell is interactive). */
  chatReady: boolean;

  /** Consecutive polls observing `chatReady && fileCount === 0`. */
  emptyTicks: number;
}

/**
 * Decide whether the boot overlay may dismiss, from the signals available on a
 * single poll. Pure + synchronous so the race that matters — *never fade an
 * import before its files arrive* — is locked by unit tests; the time-based
 * fallbacks (files-settled debounce, safety timeout) live in the overlay's
 * effect as timers.
 *
 * @returns `true` when files are confirmed loaded, or when a NON-import chat is
 *   confirmed empty (chat painted, still zero files after the confirm window).
 *   An import with `fileCount === 0` is never ready here — it waits for
 *   {@link editorFilesReady}, the files-settled debounce, or the safety timeout.
 * @example
 * isBootReady({ filesReady: true, isImport: true, fileCount: 0, chatReady: false, emptyTicks: 0 }); // true
 * isBootReady({ filesReady: false, isImport: true, fileCount: 0, chatReady: true, emptyTicks: 99 }); // false
 */
export function isBootReady(input: BootReadinessInput): boolean {
  if (input.filesReady) {
    return true;
  }

  if (!input.isImport && input.fileCount === 0 && input.chatReady && input.emptyTicks >= EMPTY_CHAT_CONFIRM_TICKS) {
    return true;
  }

  return false;
}
