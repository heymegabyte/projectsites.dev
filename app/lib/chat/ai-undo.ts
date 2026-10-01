/**
 * Undo last AI message — captures a file-tree snapshot before each
 * assistant response and restores it on demand.
 *
 * @remarks
 *   Keeps a ring buffer of the last 20 snapshots in-memory; persistence
 *   to IndexedDB is handled separately via `useChatHistory.takeSnapshot`.
 *   Storing only `{path: content}` for text files keeps memory bounded.
 */

import { atom } from 'nanostores';
import { workbenchStore } from '~/lib/stores/workbench';
import type { FileMap } from '~/lib/stores/files';

export interface AiSnapshot {
  messageId: string;
  takenAt: number;
  files: Record<string, string>;
}

const MAX_SNAPSHOTS = 20;
const snapshots: AiSnapshot[] = [];

/**
 * Reactive baseline of pre-AI-turn file content (`path → original content`), updated
 * each time a snapshot is captured. This is the "AI original" the editor's inline-diff
 * toggle diffs the current document against. Exposed as a nanostore so the Workbench
 * re-derives `fileHistory` when a new AI turn establishes a fresh baseline.
 */
export const aiOriginalFiles = atom<Record<string, string>>({});

function snapshotFromMap(files: FileMap): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [path, dirent] of Object.entries(files)) {
    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    if ((dirent as { isBinary?: boolean }).isBinary) {
      continue;
    }

    const content = (dirent as { content?: string }).content;

    if (typeof content === 'string') {
      out[path] = content;
    }
  }

  return out;
}

export function captureBeforeAssistantTurn(messageId: string): void {
  if (!messageId) {
    return;
  }

  if (snapshots.some((s) => s.messageId === messageId)) {
    return;
  }

  const files = workbenchStore.files.get();
  const snapshotFiles = snapshotFromMap(files);
  snapshots.push({ messageId, takenAt: Date.now(), files: snapshotFiles });

  while (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.shift();
  }

  // Publish the fresh pre-turn baseline so the editor inline-diff has real data to show.
  aiOriginalFiles.set(snapshotFiles);
}

export function hasSnapshotFor(messageId: string): boolean {
  return snapshots.some((s) => s.messageId === messageId);
}

export async function restoreSnapshot(messageId: string): Promise<number> {
  const snap = snapshots.find((s) => s.messageId === messageId);

  if (!snap) {
    return 0;
  }

  let restored = 0;
  const current = workbenchStore.files.get();

  for (const [path, content] of Object.entries(snap.files)) {
    const cur = current[path];

    if (cur && cur.type === 'file' && (cur as { content?: string }).content === content) {
      continue;
    }

    try {
      await workbenchStore.saveFile(path);
    } catch {
      // saveFile expects path to exist as a current document; fall back to direct write below
    }

    // Direct write fallback — sets the file content in the store and on disk via WebContainer
    const fs = (workbenchStore as unknown as { writeFile?: (p: string, c: string) => Promise<void> }).writeFile;

    if (typeof fs === 'function') {
      try {
        await fs.call(workbenchStore, path, content);
        restored += 1;
        continue;
      } catch (err) {
        console.warn('ai-undo: writeFile failed for', path, err);
      }
    }

    // Last-resort: update the store map only (in-memory) so UI shows the rollback
    workbenchStore.files.setKey(path, {
      type: 'file',
      content,
      isBinary: false,
    } as never);
    restored += 1;
  }

  return restored;
}

export function getLatestSnapshotMessageId(): string | undefined {
  return snapshots[snapshots.length - 1]?.messageId;
}
